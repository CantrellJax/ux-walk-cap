pub const FORK: bool = cfg!(feature = "ux-walk");

pub fn upstream_only<T>(build: impl FnOnce() -> T) -> Option<T> {
    (!FORK).then(build)
}
