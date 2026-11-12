//! # Valet registry
//!
//! A shared, evidence-carrying blocklist. Anyone can report an account, but a report costs a
//! small refundable deposit (anti-spam, pays for storage) and must carry an `https://` evidence
//! link. One report per (reporter, target). Reports are *advice*: the Valet oracle weighs them,
//! and a guard owner's allow list always wins, so a sybil cannot cut off a vendor you trust.

use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// 0.01 NEAR: covers the storage of one report (about 700 bytes at most).
const REPORT_DEPOSIT_YOCTO: u128 = 10_000_000_000_000_000_000_000;
const MAX_REPORTS_PER_TARGET: usize = 50;
const MAX_URL_LEN: usize = 300;
const MAX_NOTE_LEN: usize = 280;
const CATEGORIES: [&str; 5] = ["phishing", "scam", "drainer", "impersonation", "other"];

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Report {
    pub reporter: AccountId,
    pub category: String,
    pub evidence_url: String,
    pub note: String,
    pub ts_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner_id: AccountId,
    reports: LookupMap<AccountId, Vec<Report>>,
    total: u64,
}

#[near]
impl Registry {
    /// Only the contract's own account may initialize it (deploy and `new` in one batch).
    #[init]
    #[private]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id, reports: LookupMap::new(b"r"), total: 0 }
    }

    /// Report `account_id`. Attach at least 0.01 NEAR; the excess is refunded.
    #[payable]
    pub fn report(
        &mut self,
        account_id: AccountId,
        category: String,
        evidence_url: String,
        note: String,
    ) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= REPORT_DEPOSIT_YOCTO,
            "attach at least 0.01 NEAR (anti-spam deposit, refundable via `retract`)"
        );
        require!(CATEGORIES.contains(&category.as_str()), "unknown category");
        require!(
            evidence_url.starts_with("https://") && evidence_url.len() <= MAX_URL_LEN,
            "evidence_url must be an https:// link of at most 300 chars"
        );
        require!(note.len() <= MAX_NOTE_LEN, "note too long (max 280 bytes)");
        let reporter = env::predecessor_account_id();
        require!(reporter != account_id, "cannot report yourself");
        let mut list = self.reports.get(&account_id).cloned().unwrap_or_default();
        require!(list.iter().all(|r| r.reporter != reporter), "already reported by this account");
        require!(list.len() < MAX_REPORTS_PER_TARGET, "report limit reached for this account");
        list.push(Report {
            reporter: reporter.clone(),
            category: category.clone(),
            evidence_url,
            note,
            ts_ms: env::block_timestamp_ms(),
        });
        let _ = self.reports.insert(account_id.clone(), list);
        self.total += 1;
        emit("reported", json!({ "account_id": account_id, "reporter": reporter, "category": category }));
        let excess = deposit - REPORT_DEPOSIT_YOCTO;
        if excess > 0 {
            let _ = Promise::new(reporter).transfer(NearToken::from_yoctonear(excess));
        }
    }

    /// Withdraw your own report and get the deposit back.
    pub fn retract(&mut self, account_id: AccountId) -> Promise {
        let reporter = env::predecessor_account_id();
        self.take_report(&account_id, &reporter);
        emit("retracted", json!({ "account_id": account_id, "reporter": reporter }));
        Promise::new(reporter).transfer(NearToken::from_yoctonear(REPORT_DEPOSIT_YOCTO))
    }

    /// Moderation: remove an abusive report. The deposit is forfeited.
    pub fn remove_report(&mut self, account_id: AccountId, reporter: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "owner-only");
        self.take_report(&account_id, &reporter);
        emit("removed", json!({ "account_id": account_id, "reporter": reporter }));
    }

    pub fn get_reports(&self, account_id: AccountId) -> Vec<Report> {
        self.reports.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn get_report_count(&self, account_id: AccountId) -> u32 {
        self.reports.get(&account_id).map(|l| l.len() as u32).unwrap_or(0)
    }

    pub fn get_total(&self) -> u64 {
        self.total
    }
}

impl Registry {
    fn take_report(&mut self, account_id: &AccountId, reporter: &AccountId) {
        let mut list = self.reports.get(account_id).cloned().unwrap_or_default();
        let before = list.len();
        list.retain(|r| &r.reporter != reporter);
        require!(list.len() < before, "no such report");
        if list.is_empty() {
            let _ = self.reports.remove(account_id);
        } else {
            let _ = self.reports.insert(account_id.clone(), list);
        }
        self.total = self.total.saturating_sub(1);
    }
}

fn emit(event: &str, data: Value) {
    let payload = json!({ "standard": "valet-registry", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}
