//! Python environment detection commands.
//!
//! Detects `uv` and Python tooling available on the system.

use serde::Serialize;
use std::process::Command;

/// Information about the `uv` installation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvInfo {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// A tool installed via `uv tool`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvTool {
    pub name: String,
    pub version: Option<String>,
    pub commands: Vec<String>,
}

/// Information about a Python interpreter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInfo {
    pub path: String,
    pub version: Option<String>,
    pub sleap_nn_version: Option<String>,
    pub sleap_version: Option<String>,
}

/// Run a command and return (stdout, success).
fn run_command(program: &str, args: &[&str]) -> Option<String> {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                None
            }
        })
}

/// Find the absolute path of a program using `which` (Unix) or `where` (Windows).
fn which_program(name: &str) -> Option<String> {
    #[cfg(windows)]
    let cmd = "where";
    #[cfg(not(windows))]
    let cmd = "which";

    run_command(cmd, &[name]).map(|s| {
        // `where` on Windows may return multiple lines; take the first.
        s.lines().next().unwrap_or(&s).to_string()
    })
}

/// Detect whether `uv` is installed and get its version.
#[tauri::command]
pub async fn detect_uv() -> UvInfo {
    let path = which_program("uv");
    if path.is_none() {
        return UvInfo {
            available: false,
            version: None,
            path: None,
        };
    }

    let version = run_command("uv", &["--version"]).map(|v| {
        // Output is "uv 0.6.x" — strip the prefix
        v.strip_prefix("uv ").unwrap_or(&v).to_string()
    });

    UvInfo {
        available: true,
        version,
        path,
    }
}

/// List tools installed via `uv tool`.
#[tauri::command]
pub async fn list_uv_tools() -> Vec<UvTool> {
    let output = match run_command("uv", &["tool", "list"]) {
        Some(s) => s,
        None => return vec![],
    };

    parse_uv_tool_list(&output)
}

/// Parse the output of `uv tool list`.
///
/// Format:
/// ```text
/// package-name v0.1.0
///     - command1
///     - command2
/// another-package v0.2.0
///     - another-command
/// ```
fn parse_uv_tool_list(output: &str) -> Vec<UvTool> {
    let mut tools = Vec::new();
    let mut current: Option<UvTool> = None;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with("- ") {
            // Command entry
            if let Some(ref mut tool) = current {
                tool.commands.push(trimmed[2..].to_string());
            }
        } else {
            // New tool entry — push previous if any
            if let Some(tool) = current.take() {
                tools.push(tool);
            }

            // Parse "name vX.Y.Z" or "name X.Y.Z"
            let mut parts = trimmed.splitn(2, ' ');
            let name = parts.next().unwrap_or(trimmed).to_string();
            let version = parts.next().map(|v| {
                v.trim().strip_prefix('v').unwrap_or(v.trim()).to_string()
            });

            current = Some(UvTool {
                name,
                version,
                commands: Vec::new(),
            });
        }
    }

    if let Some(tool) = current {
        tools.push(tool);
    }

    tools
}

/// Check a specific Python interpreter for version and sleap-nn/sleap availability.
#[tauri::command]
pub async fn check_python(python_path: String) -> PythonInfo {
    let version = run_command(&python_path, &["--version"]).map(|v| {
        // Output is "Python 3.11.x" — strip the prefix
        v.strip_prefix("Python ").unwrap_or(&v).to_string()
    });

    let sleap_nn_version = run_command(
        &python_path,
        &["-c", "import sleap_nn; print(sleap_nn.__version__)"],
    );

    let sleap_version = run_command(
        &python_path,
        &["-c", "import sleap; print(sleap.__version__)"],
    );

    PythonInfo {
        path: python_path,
        version,
        sleap_nn_version,
        sleap_version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_uv_tool_list_empty() {
        assert!(parse_uv_tool_list("").is_empty());
    }

    #[test]
    fn test_parse_uv_tool_list_single() {
        let output = "sleap-nn v0.1.1\n    - sleap-nn\n";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "sleap-nn");
        assert_eq!(tools[0].version, Some("0.1.1".to_string()));
        assert_eq!(tools[0].commands, vec!["sleap-nn"]);
    }

    #[test]
    fn test_parse_uv_tool_list_multiple() {
        let output = "\
sleap-nn v0.1.1
    - sleap-nn
ruff v0.5.0
    - ruff
";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "sleap-nn");
        assert_eq!(tools[1].name, "ruff");
        assert_eq!(tools[1].version, Some("0.5.0".to_string()));
    }

    #[test]
    fn test_parse_uv_tool_list_multiple_commands() {
        let output = "\
sleap v0.2.0
    - sleap
    - sleap-train
    - sleap-track
";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].commands, vec!["sleap", "sleap-train", "sleap-track"]);
    }
}
