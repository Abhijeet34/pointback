// Loaded into a daemon under test with --import: the start exits 1 before it claims the state
// directory, as a start the platform refuses does. The CLI that loads it is left alone.
if (process.argv[2] === "server") {
  console.error("this start was refused before it claimed the state directory");
  process.exit(1);
}
