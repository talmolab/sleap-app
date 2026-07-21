/**
 * Headless environment shim for integration scripts run with plain `bun`
 * (outside `bun test`, so bunfig's [test].preload does not apply). Import this
 * FIRST — module side-effect order registers the DOM before any app module
 * (toast/notify, stores) is evaluated.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}
process.env.BASE_URL = "/";
process.env.MODE ??= "test";
process.env.DEV ??= "true";
process.env.PROD ??= "";
