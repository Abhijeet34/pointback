// Loaded into a daemon under test with --import: its exit is held TEST_EXIT_HOLD_MS with its port
// still bound and answering, as a busy Windows runner holds a process it was told to end (hunt
// 37250521173, attempt 16). "never" holds it for good. The CLI that loads it is left alone.
if (process.argv[2] === "server") {
  const hold = process.env.TEST_EXIT_HOLD_MS;
  const exit = process.exit.bind(process);
  process.exit = (code) => {
    if (hold !== "never") setTimeout(() => exit(code), Number(hold));
  };
}
