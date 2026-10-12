// Loaded with --import: appends `<pid> read` or `<pid> write` to TEST_ICACLS_LOG for every icacls run
// this process makes, so a test can count what a start costs on Windows. icacls given the path alone
// only reads its ACL.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, ...rest) {
  if (file === "icacls")
    appendFileSync(
      process.env.TEST_ICACLS_LOG,
      `${process.pid} ${args.length === 1 ? "read" : "write"}\n`,
    );
  return execFileSync.call(this, file, args, ...rest);
};
// state-dir.js imports execFileSync by name, which sees the patch only once it is synced.
syncBuiltinESMExports();
