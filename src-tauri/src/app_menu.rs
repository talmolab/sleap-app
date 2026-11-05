//! The native menu bar, built from the app's own menu definition.
//!
//! The web app sends its menus as plain data (`MenuSpec`, from
//! `src/lib/menu/nativeMenu.ts`) whenever something they show changes, and
//! `set_app_menu` rebuilds the OS menu bar from it. Clicking an item emits an
//! `app-menu` event carrying the item's id, which the web app runs exactly as
//! a click in its in-window menu bar would.
//!
//! Around the app's menus this adds what macOS expects: the application menu
//! (About, Hide, Quit), the system text-editing items in Labels ▸ Text Editing
//! (Cut/Copy/Paste/Select All, so text fields keep working), and Window.
//! There are deliberately NO system Undo/Redo items: their ⌘Z/⇧⌘Z would
//! intercept the keystroke before the WebView, so the app's own undo never
//! ran. The app's Labels ▸ Undo shows the shortcut as a hint and its own key
//! handler does the work.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
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

    for top in &spec.menus {
        let sub = Submenu::with_id(app, top.id.as_str(), top.label.as_str(), true)?;
        append_nodes(app, &sub, &top.items)?;
        if top.id == "labels" {
            // The app has no Edit menu (like PyQt SLEAP), but text fields
            // need the system Cut/Copy/Paste/Select All: macOS delivers
            // ⌘X/⌘C/⌘V/⌘A to a focused text field through these items
            // (from any submenu). So they sit, out of the way, in
            // Labels ▸ Text Editing.
            let text_editing = Submenu::with_id(app, "system.textEditing", "Text Editing", true)?;
            let items: [&dyn IsMenuItem<R>; 4] = [
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ];
            text_editing.append_items(&items)?;
            sub.append(&PredefinedMenuItem::separator(app)?)?;
            sub.append(&text_editing)?;
        }
        menu.append(&sub)?;
    }

    let window_menu = Submenu::new(app, "Window", true)?;
    window_menu.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    window_menu.append(&PredefinedMenuItem::close_window(app, None)?)?;
    menu.append(&window_menu)?;

    Ok(menu)
}

/// The installed menu's shape (see `shape_of`), to tell a change of labels,
/// checkmarks or enabled state — applied in place — from one that needs a
/// rebuild.
#[derive(Default)]
struct InstalledShape(Mutex<Option<String>>);

/// Everything about the menu except labels, checkmarks and enabled state:
/// the ids, kinds and shortcuts of every item, in order.
fn shape_of(spec: &MenuSpec) -> String {
    fn walk(out: &mut String, nodes: &[MenuNode]) {
        for node in nodes {
            match node {
                MenuNode::Item { id, accelerator, .. } => {
                    let _ = write!(out, "i:{id}:{};", accelerator.as_deref().unwrap_or(""));
                }
                MenuNode::Check { id, accelerator, .. } => {
                    let _ = write!(out, "c:{id}:{};", accelerator.as_deref().unwrap_or(""));
                }
                MenuNode::Submenu { id, items, .. } => {
                    let _ = write!(out, "s:{id}[");
                    walk(out, items);
                    out.push_str("];");
                }
                MenuNode::Separator => out.push_str("-;"),
            }
        }
    }
    let mut out = String::new();
    for top in &spec.menus {
        let _ = write!(out, "{}:{}[", top.id, top.label);
        walk(&mut out, &top.items);
        out.push_str("];");
    }
    out
}

/// Every item of the installed menu by id (submenus included).
fn items_by_id<R: Runtime>(menu: &Menu<R>) -> tauri::Result<HashMap<String, MenuItemKind<R>>> {
    fn walk<R: Runtime>(
        out: &mut HashMap<String, MenuItemKind<R>>,
        items: Vec<MenuItemKind<R>>,
    ) -> tauri::Result<()> {
        for item in items {
            if let MenuItemKind::Submenu(sub) = &item {
                walk(out, sub.items()?)?;
            }
            out.insert(item.id().0.clone(), item);
        }
        Ok(())
    }
    let mut out = HashMap::new();
    walk(&mut out, menu.items()?)?;
    Ok(out)
}

/// Bring the installed menu's labels, checkmarks and enabled state up to date
/// with `spec` (same shape), touching only what changed.
fn update_in_place<R: Runtime>(menu: &Menu<R>, spec: &MenuSpec) -> tauri::Result<()> {
    let items = items_by_id(menu)?;
    fn walk<R: Runtime>(
        items: &HashMap<String, MenuItemKind<R>>,
        nodes: &[MenuNode],
    ) -> tauri::Result<()> {
        for node in nodes {
            match node {
                MenuNode::Item { id, label, enabled, .. } => {
                    if let Some(MenuItemKind::MenuItem(item)) = items.get(id) {
                        if item.text()? != *label {
                            item.set_text(label)?;
                        }
                        if item.is_enabled()? != *enabled {
                            item.set_enabled(*enabled)?;
                        }
                    }
                }
                MenuNode::Check { id, label, enabled, checked, .. } => {
                    if let Some(MenuItemKind::Check(item)) = items.get(id) {
                        if item.text()? != *label {
                            item.set_text(label)?;
                        }
                        if item.is_enabled()? != *enabled {
                            item.set_enabled(*enabled)?;
                        }
                        if item.is_checked()? != *checked {
                            item.set_checked(*checked)?;
                        }
                    }
                }
                MenuNode::Submenu { id, label, enabled, items: children } => {
                    if let Some(MenuItemKind::Submenu(sub)) = items.get(id) {
                        if sub.text()? != *label {
                            sub.set_text(label)?;
                        }
                        if sub.is_enabled()? != *enabled {
                            sub.set_enabled(*enabled)?;
                        }
                    }
                    walk(items, children)?;
                }
                MenuNode::Separator => {}
            }
        }
        Ok(())
    }
    for top in &spec.menus {
        walk(&items, &top.items)?;
    }
    Ok(())
}

/// Show the web app's menus in the menu bar. When only labels, checkmarks or
/// enabled state changed (the usual case: a selection, an edit), the
/// installed items are updated in place — replacing the whole menu bar made
/// it visibly flash on every click. It's rebuilt only when its shape changes
/// (e.g. a track is added).
#[tauri::command]
pub fn set_app_menu<R: Runtime>(app: AppHandle<R>, spec: MenuSpec) -> Result<(), String> {
    if app.try_state::<InstalledShape>().is_none() {
        app.manage(InstalledShape::default());
    }
    let state = app.state::<InstalledShape>();
    let mut installed = state.0.lock().map_err(|e| e.to_string())?;
    let shape = shape_of(&spec);
    if installed.as_deref() == Some(shape.as_str()) {
        if let Some(menu) = app.menu() {
            if update_in_place(&menu, &spec).is_ok() {
                return Ok(());
            }
        }
    }
    let menu = build_menu(&app, &spec).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    *installed = Some(shape);
    Ok(())
}

/// Forward a clicked item's id to the window the user is working in (system
/// items have their own behaviour; the web app ignores ids it doesn't know).
///
/// Only to that window: the menu bar is shared by every SLEAP window, and a
/// broadcast had each open window run the command (File ▸ Open Project
/// showed one file picker per window).
pub fn forward_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let windows = app.webview_windows();
    let target = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next());
    if let Some(window) = target {
        let _ = app.emit_to(window.label(), MENU_EVENT, id.to_string());
    }
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

    #[test]
    fn shape_ignores_labels_checkmarks_and_enabled_state() {
        let parse = |json: &str| -> MenuSpec { serde_json::from_str(json).unwrap() };
        let a = parse(
            r#"{"menus":[{"id":"labels","label":"Labels","items":[
                {"kind":"item","id":"labels.undo","label":"Undo","enabled":false},
                {"kind":"check","id":"view.fit","label":"Fit","enabled":true,"checked":false}
            ]}]}"#,
        );
        let b = parse(
            r#"{"menus":[{"id":"labels","label":"Labels","items":[
                {"kind":"item","id":"labels.undo","label":"Undo Move Node","enabled":true},
                {"kind":"check","id":"view.fit","label":"Fit","enabled":true,"checked":true}
            ]}]}"#,
        );
        let c = parse(
            r#"{"menus":[{"id":"labels","label":"Labels","items":[
                {"kind":"item","id":"labels.undo","label":"Undo","enabled":false},
                {"kind":"separator"},
                {"kind":"check","id":"view.fit","label":"Fit","enabled":true,"checked":false}
            ]}]}"#,
        );
        assert_eq!(shape_of(&a), shape_of(&b));
        assert_ne!(shape_of(&a), shape_of(&c));
    }
}
