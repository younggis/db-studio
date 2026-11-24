const fs = require("node:fs/promises");
const path = require("node:path");

const customActionId = "grantAllApplicationPackagesRead";

function replaceExactlyOnce(source, pattern, replacement, description) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one ${description} in generated WiX project`);
  }
  return source.replace(pattern, replacement);
}

module.exports = async function addSandboxInstallDirectoryAccess(projectDirectory) {
  const projectPath = projectDirectory.toLowerCase().endsWith(".wxs")
    ? projectDirectory
    : path.join(projectDirectory, "project.wxs");
  let xml = await fs.readFile(projectPath, "utf8");

  if (xml.includes(`Id="${customActionId}"`)) {
    throw new Error(`WiX project already contains ${customActionId}`);
  }

  const action =
    // APPLICATIONFOLDER is emitted with a trailing backslash. A quoted
    // Windows argument ending in `\\"` can escape its closing quote and make
    // icacls reject the path (ERROR_INVALID_NAME). Appending `.` preserves the
    // same directory while keeping the closing quote unambiguous.
    '  <CustomAction Id="grantAllApplicationPackagesRead" Directory="APPLICATIONFOLDER" ExeCommand="&quot;[SystemFolder]icacls.exe&quot; &quot;[APPLICATIONFOLDER].&quot; /grant *S-1-15-2-1:(OI)(CI)(RX)" Execute="deferred" Impersonate="yes" Return="check" />';
  xml = replaceExactlyOnce(
    xml,
    /(<CustomAction\b(?=[^>]*\bId="runAfterFinish")[^>]*\/>)/g,
    `${action}\n$1`,
    "runAfterFinish custom action",
  );
  xml = replaceExactlyOnce(
    xml,
    /(<InstallExecuteSequence>)([\s\S]*?)(<\/InstallExecuteSequence>)/g,
    `$1\n      <Custom Action="${customActionId}" After="InstallFiles">NOT REMOVE</Custom>$2$3`,
    "InstallExecuteSequence",
  );

  await fs.writeFile(projectPath, xml, "utf8");
};
