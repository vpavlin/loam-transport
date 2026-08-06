# scala — build + load the modules

Templates to build `scala_core` (with the shared `logos_transport.hpp`) and run it as a
headless hub. Copy into your `scala_core/` project and replace the `scala_core`
placeholders + add your engine/crypto sources.

## Build
1. `flake.nix` → `scala_core/flake.nix` (pins the channels delivery_module + builder revs).
2. `metadata.json` → `scala_core/metadata.json` (`type:core`, dep `delivery_module`, ASCII-only).
3. `CMakeLists.txt` → `scala_core/CMakeLists.txt` (lists `src/logos_transport.hpp` — **git add it**).
4. Put `../logos_transport.hpp` at `scala_core/src/logos_transport.hpp`, write `scala_core_impl.{h,cpp}` (wire the transport per `basecamp/README.md`), `git add` everything.
5. `nix build .#lgx-portable` → produces `scala_core`'s portable `.lgx`. This is also the real SDK compile-check the header still needs.

## Load the modules (headless hub, no phone needed to test)
The hub loads THREE modules from one dir: `scala_core`, `delivery_module`, `capability_module`.
- `delivery_module` + `capability_module` come from your flake inputs after `nix build` (or copy
  their `.lgx` from an existing KYM/qaku hub modules dir, e.g. `~/kym-hub/lmods-new2/`).
- **logoscore must be built on cpp-sdk >= `d77c3dd`** (PR #68) or the hub receives nothing
  (off-thread `messageReceived` dropped by Qt Remote Objects). The newer daemon-CLI logoscore
  has it.
- `hub-run.sh` → `scala/hub/hub-run.sh`: `SCALA_MODULES_DIR=<dir with the 3 .lgx> ./hub-run.sh`.
  It pins the fleet `entryNodes` and arms `SCALA_HUB=1` (the self-drive tick — a QTimer on the
  event-loop thread, NOT a std::thread, or `createNode` hangs).
- `hub.service` → systemd `--user` unit (`Restart=always`, `loginctl enable-linger`).

## Two-peer test
Run the hub (above) AND a GUI Basecamp scala on the same room/topic. Author on one → it folds
on the other. Instrument `tx` (sends) / `rx` (onReceive opens): `tx>0, rx=0` on the hub ⇒ the
`d77c3dd` gotcha or missing `entryNodes`.
