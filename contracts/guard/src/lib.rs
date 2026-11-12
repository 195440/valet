//! # Valet guard
//!
//! A vault for AI agents on NEAR. The guard account holds the funds; the agent only holds a
//! *function-call access key* restricted to `pay` on this very account, so it can never transfer
//! directly, add keys, or deploy code. Everything the agent wants to spend goes through `pay`,
//! which enforces on-chain:
//!
//! * a per-transaction cap and a rolling-window cap (hourly buckets, conservative),
//! * an owner-curated deny list and allow list,
//! * for every receiver that is not allow-listed: an ed25519-signed risk attestation from the
//!   configured oracle (bound to this guard, receiver, max amount, expiry and a single-use nonce),
//! * a human approval queue for `warn` verdicts, and a kill switch.
//!
//! The risk oracle is advisory *and* enforced: an agent that skips the off-chain check simply has
//! no valid attestation, and the contract refuses to pay.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, Allowance, NearToken, PanicOnDefault, Promise, PublicKey,
};

const HOUR_MS: u64 = 3_600_000;
const MAX_WINDOW_HOURS: u32 = 72;
const MAX_PENDING: u32 = 20;
const MIN_TTL_MS: u64 = 60_000;
const MAX_TTL_MS: u64 = 30 * 24 * HOUR_MS;
/// The guard never pays out the last 0.05 NEAR, so it can always pay gas for the agent's key.
const RESERVE_YOCTO: u128 = 50_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    /// Hard cap for a single payment (yoctoNEAR).
    pub per_tx_cap: U128,
    /// Hard cap for everything paid inside the rolling window (yoctoNEAR).
    pub window_cap: U128,
    /// Rolling window length in hours (1..=72).
    pub window_hours: u32,
    /// How long a `warn` payment waits for human approval before it expires (ms).
    pub pending_ttl_ms: U64,
}

/// Oracle verdict for one (guard, receiver, max_amount) tuple. All numbers are JSON strings.
#[near(serializers = [json])]
pub struct Attestation {
    pub max_amount: U128,
    /// "allow" | "warn" | "block"
    pub verdict: String,
    pub expires_ms: U64,
    pub nonce: U64,
    /// 64 lowercase hex chars (sha256 of the reasons the oracle will show humans) or "0".
    pub reasons: String,
    /// ed25519 signature over `attestation_message`, base64.
    pub signature: Base64VecU8,
}

#[near(serializers = [json])]
pub struct PayResult {
    /// "paid" | "queued" | "blocked"
    pub status: String,
    pub reason: Option<String>,
    pub pending_id: Option<U64>,
}

#[near(serializers = [borsh])]
pub struct Pending {
    receiver: AccountId,
    amount: u128,
    created_ms: u64,
    expires_ms: u64,
    reasons: String,
    agent_pk: PublicKey,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct ReceiverStats {
    paid_count: u32,
    total_paid: u128,
    first_paid_ms: u64,
    last_paid_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Stats {
    paid: u64,
    queued: u64,
    blocked: u64,
    approved: u64,
    rejected: u64,
    total_paid: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner_id: AccountId,
    oracle_pk: Option<PublicKey>,
    policy: Policy,
    paused: bool,
    allow: IterableSet<AccountId>,
    deny: IterableSet<AccountId>,
    nonces: LookupSet<u64>,
    buckets: LookupMap<u64, u128>,
    pending: IterableMap<u64, Pending>,
    next_pending_id: u64,
    receivers: LookupMap<AccountId, ReceiverStats>,
    stats: Stats,
}

#[near]
impl Guard {
    /// Deploy and initialise in the same transaction. `owner_id` is the human (or multisig) that
    /// controls policy and approvals; it is never the agent.
    /// Only the contract's own account may initialize it (deploy and `new` in one batch), so
    /// nobody can front-run the owner between the two steps.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, oracle_public_key: Option<PublicKey>, policy: Policy) -> Self {
        check_policy(&policy);
        Self {
            owner_id,
            oracle_pk: oracle_public_key,
            policy,
            paused: false,
            allow: IterableSet::new(b"a"),
            deny: IterableSet::new(b"d"),
            nonces: LookupSet::new(b"n"),
            buckets: LookupMap::new(b"w"),
            pending: IterableMap::new(b"p"),
            next_pending_id: 1,
            receivers: LookupMap::new(b"r"),
            stats: Stats::default(),
        }
    }

    // ------------------------------------------------------------------ agent entry point

    /// The only method the agent's function-call key may call. Never moves funds outside policy.
    /// Policy-level refusals are *returned* (not panicked) so the audit trail is kept on-chain.
    pub fn pay(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        attestation: Option<Attestation>,
    ) -> PayResult {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "agent-only: call `pay` with an access key of the guard account"
        );
        let amount = amount.0;
        if self.paused {
            return self.blocked(&receiver_id, amount, "paused");
        }
        if amount == 0 {
            return self.blocked(&receiver_id, amount, "zero_amount");
        }
        if receiver_id == env::current_account_id() {
            return self.blocked(&receiver_id, amount, "self_transfer");
        }
        if amount > self.policy.per_tx_cap.0 {
            return self.blocked(&receiver_id, amount, "per_tx_cap");
        }
        if self.deny.contains(&receiver_id) {
            return self.blocked(&receiver_id, amount, "denylisted");
        }
        if self.window_spent().saturating_add(amount) > self.policy.window_cap.0 {
            return self.blocked(&receiver_id, amount, "window_cap");
        }
        if !self.has_funds(amount) {
            return self.blocked(&receiver_id, amount, "insufficient_funds");
        }
        if self.allow.contains(&receiver_id) {
            return self.execute(receiver_id, amount, "allowlist");
        }
        let Some(att) = attestation else {
            return self.blocked(&receiver_id, amount, "attestation_required");
        };
        if let Err(code) = self.check_attestation(&receiver_id, amount, &att) {
            return self.blocked(&receiver_id, amount, code);
        }
        match att.verdict.as_str() {
            "block" => self.blocked(&receiver_id, amount, "oracle_block"),
            "warn" => self.queue(receiver_id, amount, att),
            _ => {
                let _ = self.nonces.insert(att.nonce.0);
                self.execute(receiver_id, amount, "attestation")
            }
        }
    }

    // ------------------------------------------------------------------ owner: approvals

    /// Release a queued `warn` payment. Caps, deny list, kill switch and balance still apply.
    pub fn approve(&mut self, id: U64) -> PayResult {
        self.assert_owner();
        require!(!self.paused, "paused");
        let (receiver, amount, expires_ms) = match self.pending.get(&id.0) {
            Some(p) => (p.receiver.clone(), p.amount, p.expires_ms),
            None => env::panic_str("no_such_pending"),
        };
        let refuse = |reason: &str| PayResult {
            status: "blocked".to_string(),
            reason: Some(reason.to_string()),
            pending_id: Some(id),
        };
        if env::block_timestamp_ms() > expires_ms {
            let _ = self.pending.remove(&id.0);
            emit("payment_expired", json!({ "pending_id": id, "receiver_id": receiver }));
            return refuse("expired");
        }
        if self.deny.contains(&receiver) {
            return refuse("denylisted");
        }
        if self.window_spent().saturating_add(amount) > self.policy.window_cap.0 {
            return refuse("window_cap");
        }
        if !self.has_funds(amount) {
            return refuse("insufficient_funds");
        }
        let _ = self.pending.remove(&id.0);
        self.stats.approved += 1;
        emit(
            "payment_approved",
            json!({ "pending_id": id, "receiver_id": receiver, "amount": U128(amount) }),
        );
        let mut result = self.execute(receiver, amount, "owner_approval");
        result.pending_id = Some(id);
        result
    }

    pub fn reject(&mut self, id: U64) {
        self.assert_owner();
        let Some(p) = self.pending.remove(&id.0) else {
            env::panic_str("no_such_pending");
        };
        self.stats.rejected += 1;
        emit(
            "payment_rejected",
            json!({ "pending_id": id, "receiver_id": p.receiver, "amount": U128(p.amount) }),
        );
    }

    // ------------------------------------------------------------------ owner: configuration

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        check_policy(&policy);
        emit("policy_updated", json!({ "policy": policy }));
        self.policy = policy;
    }

    pub fn set_oracle(&mut self, oracle_public_key: Option<PublicKey>) {
        self.assert_owner();
        emit("oracle_updated", json!({ "oracle_public_key": oracle_public_key }));
        self.oracle_pk = oracle_public_key;
    }

    pub fn allow(&mut self, account_id: AccountId) {
        self.assert_owner();
        let _ = self.deny.remove(&account_id);
        let _ = self.allow.insert(account_id.clone());
        emit("allowlist_added", json!({ "account_id": account_id }));
    }

    pub fn unallow(&mut self, account_id: AccountId) {
        self.assert_owner();
        let _ = self.allow.remove(&account_id);
        emit("allowlist_removed", json!({ "account_id": account_id }));
    }

    pub fn deny(&mut self, account_id: AccountId) {
        self.assert_owner();
        let _ = self.allow.remove(&account_id);
        let _ = self.deny.insert(account_id.clone());
        emit("denylist_added", json!({ "account_id": account_id }));
    }

    pub fn undeny(&mut self, account_id: AccountId) {
        self.assert_owner();
        let _ = self.deny.remove(&account_id);
        emit("denylist_removed", json!({ "account_id": account_id }));
    }

    /// Kill switch: `pay` and `approve` refuse everything until `unpause`.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", json!({}));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("unpaused", json!({}));
    }

    /// The owner can always take the money back (it is the owner's money).
    pub fn withdraw(&mut self, to: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(self.free_balance() >= amount.0, "insufficient_funds");
        emit("withdrawn", json!({ "to": to, "amount": amount }));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Give an agent a key that can do exactly one thing: call `pay` on this account.
    /// `allowance` (yoctoNEAR) caps the gas the key can ever burn.
    pub fn add_agent_key(&mut self, public_key: PublicKey, allowance: U128) -> Promise {
        self.assert_owner();
        let allowance = Allowance::limited(NearToken::from_yoctonear(allowance.0))
            .unwrap_or_else(|| env::panic_str("allowance must be greater than zero"));
        emit("agent_key_added", json!({ "public_key": public_key }));
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            "pay".to_string(),
        )
    }

    pub fn revoke_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        emit("agent_key_revoked", json!({ "public_key": public_key }));
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Value {
        json!({
            "owner_id": self.owner_id,
            "oracle_public_key": self.oracle_pk,
            "policy": self.policy,
            "paused": self.paused,
            "pending_count": self.pending.len(),
            "version": env!("CARGO_PKG_VERSION"),
        })
    }

    pub fn get_stats(&self) -> Value {
        json!({
            "paid": self.stats.paid,
            "queued": self.stats.queued,
            "blocked": self.stats.blocked,
            "approved": self.stats.approved,
            "rejected": self.stats.rejected,
            "total_paid": U128(self.stats.total_paid),
        })
    }

    pub fn get_window_spent(&self) -> U128 {
        U128(self.window_spent())
    }

    pub fn get_pending(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Value> {
        self.pending
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20) as usize)
            .map(|(id, p)| {
                json!({
                    "id": U64(*id),
                    "receiver_id": p.receiver,
                    "amount": U128(p.amount),
                    "created_ms": p.created_ms,
                    "expires_ms": p.expires_ms,
                    "reasons": p.reasons,
                    "agent_public_key": p.agent_pk,
                })
            })
            .collect()
    }

    pub fn get_receiver_stats(&self, account_id: AccountId) -> Value {
        match self.receivers.get(&account_id) {
            Some(s) => json!({
                "paid_count": s.paid_count,
                "total_paid": U128(s.total_paid),
                "first_paid_ms": s.first_paid_ms,
                "last_paid_ms": s.last_paid_ms,
            }),
            None => Value::Null,
        }
    }

    pub fn get_allowlist(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<AccountId> {
        self.allow
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_denylist(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<AccountId> {
        self.deny
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .cloned()
            .collect()
    }

    pub fn is_allowed(&self, account_id: AccountId) -> bool {
        self.allow.contains(&account_id)
    }

    pub fn is_denied(&self, account_id: AccountId) -> bool {
        self.deny.contains(&account_id)
    }
}

// ---------------------------------------------------------------------- internals (not exported)

impl Guard {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner-only");
    }

    fn blocked(&mut self, receiver: &AccountId, amount: u128, reason: &str) -> PayResult {
        self.stats.blocked += 1;
        emit(
            "payment_blocked",
            json!({
                "receiver_id": receiver,
                "amount": U128(amount),
                "reason": reason,
                "agent_public_key": env::signer_account_pk(),
            }),
        );
        PayResult {
            status: "blocked".to_string(),
            reason: Some(reason.to_string()),
            pending_id: None,
        }
    }

    fn queue(&mut self, receiver: AccountId, amount: u128, att: Attestation) -> PayResult {
        if self.pending.len() >= MAX_PENDING {
            return self.blocked(&receiver, amount, "pending_full");
        }
        let id = self.next_pending_id;
        self.next_pending_id += 1;
        let now = env::block_timestamp_ms();
        let _ = self.nonces.insert(att.nonce.0);
        let agent_pk = env::signer_account_pk();
        let _ = self.pending.insert(
            id,
            Pending {
                receiver: receiver.clone(),
                amount,
                created_ms: now,
                expires_ms: now.saturating_add(self.policy.pending_ttl_ms.0),
                reasons: att.reasons.clone(),
                agent_pk: agent_pk.clone(),
            },
        );
        self.stats.queued += 1;
        emit(
            "payment_queued",
            json!({
                "pending_id": U64(id),
                "receiver_id": receiver,
                "amount": U128(amount),
                "reasons": att.reasons,
                "agent_public_key": agent_pk,
            }),
        );
        PayResult {
            status: "queued".to_string(),
            reason: Some("oracle_warn".to_string()),
            pending_id: Some(U64(id)),
        }
    }

    fn execute(&mut self, receiver: AccountId, amount: u128, via: &str) -> PayResult {
        let now = env::block_timestamp_ms();
        self.record_spend(amount);
        let (count, total, first) = self
            .receivers
            .get(&receiver)
            .map(|s| (s.paid_count, s.total_paid, s.first_paid_ms))
            .unwrap_or((0, 0, now));
        let _ = self.receivers.insert(
            receiver.clone(),
            ReceiverStats {
                paid_count: count.saturating_add(1),
                total_paid: total.saturating_add(amount),
                first_paid_ms: first,
                last_paid_ms: now,
            },
        );
        self.stats.paid += 1;
        self.stats.total_paid = self.stats.total_paid.saturating_add(amount);
        emit(
            "payment_paid",
            json!({
                "receiver_id": receiver,
                "amount": U128(amount),
                "via": via,
                "agent_public_key": env::signer_account_pk(),
                "window_spent": U128(self.window_spent()),
            }),
        );
        let _ = Promise::new(receiver).transfer(NearToken::from_yoctonear(amount));
        PayResult {
            status: "paid".to_string(),
            reason: Some(via.to_string()),
            pending_id: None,
        }
    }

    /// Hourly buckets: a payment counts against the cap for at least `window_hours - 1` hours and
    /// at most `window_hours`, so the real rolling spend never exceeds the cap.
    fn window_spent(&self) -> u128 {
        let now_hour = env::block_timestamp_ms() / HOUR_MS;
        let start = now_hour.saturating_sub(self.policy.window_hours as u64 - 1);
        (start..=now_hour).fold(0u128, |acc, h| {
            acc.saturating_add(*self.buckets.get(&h).unwrap_or(&0))
        })
    }

    fn record_spend(&mut self, amount: u128) {
        let hour = env::block_timestamp_ms() / HOUR_MS;
        let current = *self.buckets.get(&hour).unwrap_or(&0);
        let _ = self.buckets.insert(hour, current.saturating_add(amount));
        if hour > MAX_WINDOW_HOURS as u64 + 1 {
            let _ = self.buckets.remove(&(hour - MAX_WINDOW_HOURS as u64 - 1));
        }
    }

    fn free_balance(&self) -> u128 {
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance().as_yoctonear().saturating_sub(storage)
    }

    fn has_funds(&self, amount: u128) -> bool {
        self.free_balance() >= amount.saturating_add(RESERVE_YOCTO)
    }

    /// Everything the oracle signed must match what the agent submits, byte for byte.
    fn check_attestation(
        &self,
        receiver: &AccountId,
        amount: u128,
        att: &Attestation,
    ) -> Result<(), &'static str> {
        if !matches!(att.verdict.as_str(), "allow" | "warn" | "block") {
            return Err("bad_verdict");
        }
        if !is_hex_or_zero(&att.reasons) {
            return Err("bad_reasons");
        }
        let Some(pk) = self.oracle_pk.as_ref() else {
            return Err("no_oracle_configured");
        };
        let pk_bytes = pk.as_bytes();
        if pk_bytes.len() != 33 || pk_bytes[0] != 0 {
            return Err("oracle_key_not_ed25519");
        }
        if amount > att.max_amount.0 {
            return Err("amount_exceeds_attestation");
        }
        if env::block_timestamp_ms() > att.expires_ms.0 {
            return Err("attestation_expired");
        }
        if self.nonces.contains(&att.nonce.0) {
            return Err("nonce_replayed");
        }
        let signature: [u8; 64] = att
            .signature
            .0
            .as_slice()
            .try_into()
            .map_err(|_| "bad_signature_length")?;
        let mut public_key = [0u8; 32];
        public_key.copy_from_slice(&pk_bytes[1..]);
        let message = attestation_message(&env::current_account_id(), receiver, att);
        if !env::ed25519_verify(&signature, message.as_bytes(), &public_key) {
            return Err("bad_signature");
        }
        Ok(())
    }
}

/// Canonical message the oracle signs. Keep in sync with `packages/oracle/src/attestation.ts`.
pub fn attestation_message(guard: &AccountId, receiver: &AccountId, att: &Attestation) -> String {
    format!(
        "VALET/1\nguard={}\nreceiver={}\nmax_amount={}\nverdict={}\nexpires_ms={}\nnonce={}\nreasons={}",
        guard, receiver, att.max_amount.0, att.verdict, att.expires_ms.0, att.nonce.0, att.reasons
    )
}

fn is_hex_or_zero(s: &str) -> bool {
    s == "0" || (s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn check_policy(p: &Policy) {
    require!(p.per_tx_cap.0 > 0, "per_tx_cap must be positive");
    require!(p.window_cap.0 >= p.per_tx_cap.0, "window_cap must be >= per_tx_cap");
    require!(
        (1..=MAX_WINDOW_HOURS).contains(&p.window_hours),
        "window_hours must be 1..=72"
    );
    require!(
        (MIN_TTL_MS..=MAX_TTL_MS).contains(&p.pending_ttl_ms.0),
        "pending_ttl_ms out of range"
    );
}

fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": "valet",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}
