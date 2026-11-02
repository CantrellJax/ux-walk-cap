#![allow(dead_code)]

fn index() -> usize {
    crate::i18n::current() as usize
}

include!(concat!(env!("OUT_DIR"), "/i18n_shipped.rs"));
