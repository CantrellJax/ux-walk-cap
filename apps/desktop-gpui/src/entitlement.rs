pub(crate) const PLAN_UNLOCKED: bool = cfg!(feature = "ux-walk");

pub(crate) const fn account_optional(ux_walk: bool, test: bool) -> bool {
    ux_walk && !test
}

// Off under cfg(test) so upstream's store test, which expects set_auth(None)
// to leave signed_in() false, keeps passing unchanged.
pub(crate) const NO_ACCOUNT_NEEDED: bool = account_optional(cfg!(feature = "ux-walk"), cfg!(test));
