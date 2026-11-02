use gpui::{Action, App, Menu, MenuItem};

use super::{
    HelpCenter, HelpDashboard, HelpDiscord, HelpDocs, HelpFaq, HelpSelfHosting, HelpStatus,
};

const FORK: bool = crate::fork_policy::FORK;

enum Destination {
    Upstream,
    Fork(&'static str),
    Hidden,
}

fn destination(action: &dyn Action) -> Destination {
    let action = action.as_any();
    let fork = |url: Option<&'static str>| url.map_or(Destination::Hidden, Destination::Fork);
    if action.is::<HelpDocs>() {
        fork(Some(fork_brand::DOCS_URL))
    } else if action.is::<HelpCenter>() {
        fork(Some(fork_brand::HELP_URL))
    } else if action.is::<HelpStatus>() {
        fork(fork_brand::STATUS_URL)
    } else if action.is::<HelpDiscord>() {
        fork(fork_brand::COMMUNITY_URL)
    } else if action.is::<HelpDashboard>()
        || action.is::<HelpFaq>()
        || action.is::<HelpSelfHosting>()
    {
        Destination::Hidden
    } else {
        Destination::Upstream
    }
}

// Registered after upstream's handlers: gpui runs global action listeners
// newest first, and stopping propagation keeps upstream's cap.so handler from
// running as well.
pub(super) fn register_help_links(cx: &mut App) {
    if !FORK {
        return;
    }
    fn open(action: &dyn Action, cx: &mut App) {
        cx.stop_propagation();
        if let Destination::Fork(url) = destination(action) {
            cx.open_url(url);
        }
    }
    cx.on_action(|action: &HelpDashboard, cx| open(action, cx));
    cx.on_action(|action: &HelpDocs, cx| open(action, cx));
    cx.on_action(|action: &HelpFaq, cx| open(action, cx));
    cx.on_action(|action: &HelpSelfHosting, cx| open(action, cx));
    cx.on_action(|action: &HelpCenter, cx| open(action, cx));
    cx.on_action(|action: &HelpStatus, cx| open(action, cx));
    cx.on_action(|action: &HelpDiscord, cx| open(action, cx));
}

pub(super) fn menus(mut menus: Vec<Menu>) -> Vec<Menu> {
    if !FORK {
        return menus;
    }
    for menu in &mut menus {
        menu.items.retain(|item| {
            !matches!(item, MenuItem::Action { action, .. }
                if matches!(destination(action.as_ref()), Destination::Hidden))
        });
        let mut items: Vec<MenuItem> = Vec::with_capacity(menu.items.len());
        for item in menu.items.drain(..) {
            let separator = matches!(item, MenuItem::Separator);
            if separator
                && items
                    .last()
                    .is_none_or(|last| matches!(last, MenuItem::Separator))
            {
                continue;
            }
            items.push(item);
        }
        if matches!(items.last(), Some(MenuItem::Separator)) {
            items.pop();
        }
        menu.items = items;
    }
    menus
}

#[cfg(all(test, feature = "ux-walk"))]
mod tests {
    use gpui::TestAppContext;

    use super::*;
    use crate::{i18n::tr, menus::build_menus, updates::UpdateStatus};

    const HELP_ACTIONS: usize = 7;

    fn help_actions() -> Vec<Box<dyn Action>> {
        vec![
            Box::new(HelpDashboard),
            Box::new(HelpDocs),
            Box::new(HelpFaq),
            Box::new(HelpSelfHosting),
            Box::new(HelpCenter),
            Box::new(HelpStatus),
            Box::new(HelpDiscord),
        ]
    }

    fn installed_menus() -> Vec<Menu> {
        menus(build_menus(&UpdateStatus::Idle, true))
    }

    #[test]
    fn every_upstream_help_link_has_a_fork_decision() {
        let help = build_menus(&UpdateStatus::Idle, true)
            .into_iter()
            .find(|menu| menu.name == tr::menu::help::title())
            .expect("Help menu");
        let opens_a_page = help
            .items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action { action, .. } => Some(action.as_ref()),
                _ => None,
            })
            .filter(|action| !matches!(destination(*action), Destination::Upstream))
            .count();
        assert_eq!(opens_a_page, HELP_ACTIONS);
        assert_eq!(help_actions().len(), HELP_ACTIONS);
    }

    #[test]
    fn help_menu_keeps_only_fork_destinations() {
        let help = installed_menus()
            .into_iter()
            .find(|menu| menu.name == tr::menu::help::title())
            .expect("Help menu");
        let names: Vec<String> = help
            .items
            .iter()
            .map(|item| match item {
                MenuItem::Separator => "-".to_string(),
                MenuItem::Action { name, .. } => name.to_string(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(
            names,
            [
                tr::menu::help::feedback(),
                "-",
                tr::menu::help::changelog(),
                "-",
                tr::menu::help::documentation(),
                tr::menu::help::help_center(),
            ]
        );
        for menu in installed_menus() {
            assert_ne!(
                menu.items
                    .first()
                    .map(|item| matches!(item, MenuItem::Separator)),
                Some(true)
            );
            assert_ne!(
                menu.items
                    .last()
                    .map(|item| matches!(item, MenuItem::Separator)),
                Some(true)
            );
        }
    }

    fn open_upstream(_: &dyn Action, cx: &mut App) {
        cx.open_url("https://cap.so/");
    }

    #[gpui::test]
    fn help_actions_open_fork_pages_instead_of_upstream(cx: &mut TestAppContext) {
        cx.update(|cx| {
            cx.on_action(|a: &HelpDashboard, cx| open_upstream(a, cx));
            cx.on_action(|a: &HelpDocs, cx| open_upstream(a, cx));
            cx.on_action(|a: &HelpFaq, cx| open_upstream(a, cx));
            cx.on_action(|a: &HelpSelfHosting, cx| open_upstream(a, cx));
            cx.on_action(|a: &HelpCenter, cx| open_upstream(a, cx));
            cx.on_action(|a: &HelpStatus, cx| open_upstream(a, cx));
            cx.on_action(|a: &HelpDiscord, cx| open_upstream(a, cx));
            register_help_links(cx);
        });
        for action in help_actions() {
            let before = cx.opened_url();
            cx.update(|cx| cx.dispatch_action(action.as_ref()));
            let expected = match destination(action.as_ref()) {
                Destination::Fork(url) => Some(url.to_string()),
                _ => before,
            };
            assert_eq!(cx.opened_url(), expected, "{}", action.name());
        }
    }

    #[test]
    fn fork_links_are_registered_after_upstream_handlers() {
        let source = include_str!("../menus.rs");
        let init = &source[source.find("pub fn init(").expect("init")..];
        let hook = init
            .find("fork::register_help_links(cx);")
            .expect("hook in init");
        for upstream in [
            "&HelpDashboard",
            "&HelpDocs",
            "&HelpFaq",
            "&HelpSelfHosting",
            "&HelpCenter",
            "&HelpStatus",
            "&HelpDiscord",
        ] {
            assert!(init.find(upstream).expect(upstream) < hook, "{upstream}");
        }
        assert!(source.contains("cx.set_menus(fork::menus(build_menus("));
    }
}
