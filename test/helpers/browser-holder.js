// A test run that holds the suite's browser until something kills it: test/browser.test.js kills it
// as a developer or a CI runner ends a hung run, and watches whether the browser goes with it.
import { launchBrowser } from "./cdp.js";

const browser = await launchBrowser(process.argv[2]);
console.log(`browser pid ${browser.pid}`);
setInterval(() => {}, 2 ** 31 - 1);
