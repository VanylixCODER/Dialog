"use strict";

// Custom Windows code-signing hook for electron-builder.
//
// Why: electron-builder's *bundled* osslsigncode is linked against OpenSSL 1.1
// (libcrypto.so.1.1), which modern distros (Arch/EndeavourOS, recent Ubuntu)
// don't ship — so the built-in signer crashes. This hook signs with the SYSTEM
// osslsigncode instead (built against OpenSSL 3).
//
//   Install it once:  Arch:   sudo pacman -S osslsigncode
//                     Debian: sudo apt install osslsigncode
//
// Signing only happens when CSC_LINK (path to the .pfx) is set, so normal
// unsigned builds keep working untouched:
//   CSC_LINK=./dialog-selfsign.pfx CSC_KEY_PASSWORD=dialog npm run dist:win

const { execFileSync } = require("child_process");
const fs = require("fs");

exports.default = async function (configuration) {
  const cert = process.env.CSC_LINK;
  if (!cert) return; // no cert provided → leave the build unsigned

  const pass = process.env.CSC_KEY_PASSWORD || "";
  const file = configuration.path;
  const hash = configuration.hash || "sha256";
  const out = file + ".signed";

  try {
    execFileSync("osslsigncode", ["--version"], { stdio: "ignore" });
  } catch (_) {
    throw new Error(
      "osslsigncode not found — needed to sign Windows builds. " +
        "Install it: `sudo pacman -S osslsigncode` (Arch) or " +
        "`sudo apt install osslsigncode` (Debian/Ubuntu)."
    );
  }

  execFileSync(
    "osslsigncode",
    [
      "sign",
      "-pkcs12", cert,
      "-pass", pass,
      "-h", hash,
      "-n", "Dialog Messanger App",
      "-i", "https://dialogmsg.xyz",
      "-t", "http://timestamp.digicert.com",
      "-in", file,
      "-out", out
    ],
    { stdio: "inherit" }
  );
  fs.renameSync(out, file);
  console.log(`  • signed (${hash}) ${file}`);
};
