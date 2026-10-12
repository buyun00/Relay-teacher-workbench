const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

async function windowsVolumes() {
  if (process.platform !== "win32") return [];
  const script =
    "Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -and $_.DriveType -in 2,3 } | Select-Object DeviceID,Label,DriveLetter,DriveType,Capacity,FreeSpace | ConvertTo-Json -Compress";
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    },
  );
  if (!stdout.trim()) return [];
  const rows = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    volumeId: row.DeviceID,
    root: row.DriveLetter + "\\",
    name: row.Label || "可移动设备",
    removable: row.DriveType === 2,
    capacity: row.Capacity,
    freeBytes: row.FreeSpace,
  }));
}
module.exports = { windowsVolumes };
