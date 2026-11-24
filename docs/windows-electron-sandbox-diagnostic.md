# Windows Electron sandbox startup diagnostic

## Scope

This is an engineering diagnostic, not a Windows repair guide and not a claim
that the application itself is defective. It records the current host context
so installer acceptance is not confused with a successful visible GUI run.

## Observations on 2026-11-15

- The host identifies itself as Windows 11 25H2, build `26200.9974`.
- The installed `DB Studio.exe` exits during early startup with
  `0x80000003` / `-2147483645` when launched with Chromium sandbox defaults.
  An isolated user-data directory and `--disable-gpu` did not change that
  result.
- A fresh MSI-installed `DB Studio.exe --version` launch on 2026-11-15
  again returned `0x80000003`. The desktop-control service briefly enumerated
  a `DB Studio` window, but could not activate it and the process was no
  longer running immediately afterwards. This is runtime evidence only; it
  does not count as visible-GUI acceptance.
- The project Electron 45.1.0 runtime and a locally cached Electron 41.2.0
  runtime also reproduce the exit code for `--version` under this execution
  context. Visual Studio Code reproduces it as well, so this result is not
  evidence of an application JavaScript, GDAL, AI, or MSI payload defect.
- An Electron 45.3.2 Windows x64 runtime was downloaded to the project cache
  and verified against the release SHA-256 (`cd1ab0d49c2f76838c0c9ff75afefb4d9d85ca59036691932bf35be8eceba98`).
  Its `electron.exe --version` also exits with `0x80000003`. The release notes
  report Chromium `156.0.8078.100`, so moving the project to this patch alone
  is not a fix for this host.
- The same 45.3.2 runtime was then pointed at the installed DB Studio package
  with a fresh profile and verbose Chromium logging enabled. It again exited
  with `0x80000003` before creating a log file, consistent with the runtime
  failing before the packaged application can initialize.
- The DB Studio directory already grants `ALL APPLICATION PACKAGES` read and
  execute access. A temporary grant for `ALL RESTRICTED APPLICATION PACKAGES`
  did not alter the outcome and was removed. `icacls /verify` completed for
  both the DB Studio and VS Code install roots. Read-only ACL inspection of
  the installed DB Studio directory and the extracted 45.3.2 runtime showed
  only named application/package, Codex sandbox, and standard local user,
  administrator, and system entries; no unknown SID was displayed there.
- `pnputil /enum-devices /class Display` listed an NVIDIA RTX 5060 Laptop GPU
  and an AMD Radeon 780M, both on PCI; `/disconnected` listed no devices, and
  `HKLM:\SYSTEM\CurrentControlSet\Enum\ROOT\DISPLAY` was absent. The
  upstream Indirect Display Driver report therefore is not corroborated by
  the display-device inventory available in this session.
- `--disable-gpu-sandbox`, renderer AppContainer disabling, a fresh profile,
  and Crashpad disabling did not resolve the tested DB Studio launch.

## Interpretation and limits

The evidence is consistent with a Windows 25H2 Chromium/Electron sandbox
compatibility problem. Electron's public issue tracker has reports with the
same `0x80000003` exit code on Windows 11 25H2, including a DACL-specific
variant and a distinct display-topology variant. The DACL-specific repair was
tested only on the DB Studio install root and did not help here; no broad ACL
reset, driver change, registry change, or system-security weakening was made.

The test processes run in an automated execution context. Therefore these
observations do not prove that a user-launched desktop session will always
fail, nor do they substitute for acceptance on a separate supported Windows
host.

## Product disposition

- Do not make `--no-sandbox` a product default or silently append it from
  application JavaScript. The process fails before application JavaScript is
  evaluated, and disabling Chromium sandboxing would weaken a security
  boundary.
- Keep the package technically installable, but mark visible GUI launch and
  interaction acceptance as pending until the host condition is resolved or a
  clean supported Windows host is available.
- Keep CLI, database, GIS, and AI integration evidence separate from this GUI
  runtime limitation.

## References

- Electron issue [#51761](https://github.com/electron/electron/issues/51761)
  documents one Windows 25H2 `0x80000003` sandbox/DACL failure mode and its
  limits.
- Electron issue [#52098](https://github.com/electron/electron/issues/52098)
  records another Windows 25H2 startup crash signature with this exit code.
- Electron [v45.3.2 release notes](https://github.com/electron/electron/releases/tag/v45.3.2)
  identify the Chromium version used for the newer-runtime comparison.
- Electron issue [#54552](https://github.com/electron/electron/issues/54552)
  documents a distinct GPU startup failure tied to Indirect Display Driver
  adapters; this host's enumerated display devices did not show that pattern.

