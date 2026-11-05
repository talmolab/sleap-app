//! The native menu bar, built from the app's own menu definition.
//!
//! The web app sends its menus as plain data (`MenuSpec`, from
//! `src/lib/menu/nativeMenu.ts`) whenever something they show changes, and
//! `set_app_menu` rebuilds the OS menu bar from it. Clicking an item emits an
//! `app-menu` event carrying the item's id, which the web app runs exactly as
//! a click in its in-window menu bar would.
//!
//! Around the app's menus this adds what macOS expects: the application menu
//! (About, Hide, Quit), a system Edit menu after File
//! (Cut/Copy/Paste/Select All, so text fields keep working), and Window.
//! There are deliberately NO system Undo/Redo items: their ⌘Z/⇧⌘Z would
//! intercept the keystroke before the WebView, so the app's own undo never
//! ran. The app's Edit ▸ Undo shows the shortcut as a hint and its own key
//! handler does the work.

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The event a clicked item's id is sent on.
pub const MENU_EVENT: &str = "app-menu";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MenuNode {
    Item {
        id: String,
        label: String,
        enabled: bool,
        accelerator: Option<String>,
    },
    Check {
        id: String,
        label: String,
        enabled: bool,
        checked: bool,
        accelerator: Option<String>,
    },
    Submenu {
        id: String,
        label: String,
        enabled: bool,
        items: Vec<MenuNode>,
    },
    Separator,
}

#[derive(Debug, Deserialize)]
pub struct TopMenu {
    pub id: String,
    pub label: String,
    pub items: Vec<MenuNode>,
}

#[derive(Debug, Deserialize)]
pub struct MenuSpec {
    pub menus: Vec<TopMenu>,
}

fn item<R: Runtime, M: Manager<R>>(
    m: &M,
    id: &str,
    label: &str,
    enabled: bool,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    // An accelerator the platform can't parse shouldn't cost the whole menu.
    MenuItem::with_id(m, id, label, enabled, accelerator)
        .or_else(|_| MenuItem::with_id(m, id, label, enabled, None::<&str>))
}

fn append_nodes<R: Runtime, M: Manager<R>>(
    m: &M,
    parent: &Submenu<R>,
    nodes: &[MenuNode],
) -> tauri::Result<()> {
    for node in nodes {
        match node {
            MenuNode::Item { id, label, enabled, accelerator } => {
                parent.append(&item(m, id, label, *enabled, accelerator.as_deref())?)?;
            }
            MenuNode::Check { id, label, enabled, checked, accelerator } => {
                let check = CheckMenuItem::with_id(
                    m,
                    id,
                    label,
                    *enabled,
                    *checked,
                    accelerator.as_deref(),
                )
                .or_else(|_| CheckMenuItem::with_id(m, id, label, *enabled, *checked, None::<&str>))?;
                parent.append(&check)?;
            }
            MenuNode::Submenu { id, label, enabled, items } => {
                let sub = Submenu::with_id(m, id, label, *enabled)?;
                append_nodes(m, &sub, items)?;
                parent.append(&sub)?;
            }
            MenuNode::Separator => {
                parent.append(&PredefinedMenuItem::separator(m)?)?;
            }
        }
    }
    Ok(())
}

/// The full menu bar: the application menu, the app's menus, then Window.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    let app_menu = Submenu::new(app, "SLEAP", true)?;
    // The app's own About and Quit (not the system ones): Quit checks for
    // unsaved changes first; both run in the web app via their ids.
    app_menu.append(&item(app, "help.about", "About SLEAP", true, None)?)?;
    app_menu.append(&PredefinedMenuItem::separator(app)?)?;
    app_menu.append(&PredefinedMenuItem::hide(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::show_all(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::separator(app)?)?;
    app_menu.append(&item(app, "file.quit", "Quit SLEAP", true, Some("CmdOrCtrl+Q"))?)?;
    menu.append(&app_menu)?;

    for (i, top) in spec.menus.iter().enumerate() {
        let sub = Submenu::with_id(app, top.id.as_str(), top.label.as_str(), true)?;
        append_nodes(app, &sub, &top.items)?;
        menu.append(&sub)?;
        if i == 0 {
            // Edit, after the first menu (File) as on any Mac: the app has no
            // Edit menu of its own (like PyQt SLEAP), but text fields need
            // the system Cut/Copy/Paste/Select All — macOS ties ⌘C/⌘V in a
            // text field to these items.
            let edit = Submenu::with_id(app, "system.edit", "Edit", true)?;
            let text_editing: [&dyn IsMenuItem<R>; 4] = [
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ];
            edit.append_items(&text_editing)?;
            menu.append(&edit)?;
        }
    }

    let window_menu = Submenu::new(app, "Window", true)?;
    window_menu.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    window_menu.append(&PredefinedMenuItem::close_window(app, None)?)?;
    menu.append(&window_menu)?;

    Ok(menu)
}

/// Replace the menu bar with one built from the web app's menus.
#[tauri::command]
pub fn set_app_menu<R: Runtime>(app: AppHandle<R>, spec: MenuSpec) -> Result<(), String> {
    let menu = build_menu(&app, &spec).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Forward a clicked item's id to the web app (system items have their own
/// behaviour; the web app ignores ids it doesn't know).
pub fn forward_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit(MENU_EVENT, id.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_spec_the_web_app_sends() {
        let spec: MenuSpec = serde_json::from_str(
            r#"{"menus":[{"id":"file","label":"File","items":[
                {"kind":"item","id":"file.save","label":"Save","enabled":true,"accelerator":"CmdOrCtrl+S"},
                {"kind":"separator"},
                {"kind":"check","id":"view.fit","label":"Fit","enabled":true,"checked":false},
                {"kind":"submenu","id":"file.export","label":"Export","enabled":false,"items":[]}
            ]}]}"#,
        )
        .unwrap();
        assert_eq!(spec.menus[0].items.len(), 4);
        assert!(matches!(
            &spec.menus[0].items[0],
            MenuNode::Item { accelerator: Some(a), .. } if a == "CmdOrCtrl+S"
        ));
        assert!(matches!(&spec.menus[0].items[2], MenuNode::Check { accelerator: None, .. }));
    }
}
