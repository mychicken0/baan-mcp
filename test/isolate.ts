// Imported first by every test that runs the CLI. Points the background-service files (systemd unit,
// desktop autostart, launchd plist, Windows Startup script) at a throwaway folder and a test-only name,
// so `baan start` in a test never sees, rewrites or restarts the real baan service on this computer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "baan-test-home-"));
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.APPDATA = join(home, "AppData");
process.env.BAAN_SERVICE_NAME = `baan-test-${process.pid}`;
