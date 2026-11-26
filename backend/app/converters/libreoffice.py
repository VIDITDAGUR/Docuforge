from pathlib import Path
import shutil
import subprocess
import tempfile


def find_libreoffice() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def convert_with_libreoffice(input_path: Path, output_path: Path, target_ext: str = "pdf") -> bool:
    """
    Converts input_path using headless LibreOffice into output_path if LibreOffice
    is installed on the host. Uses an isolated UserInstallation profile directory
    so concurrent requests never collide on LibreOffice's profile lock.
    """
    lo_bin = find_libreoffice()
    if not lo_bin:
        return False

    profile_dir = Path(tempfile.mkdtemp(prefix="docuforge_lo_"))
    out_dir = output_path.parent
    try:
        cmd = [
            lo_bin,
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation=file://{profile_dir}",
            "--convert-to",
            target_ext,
            "--outdir",
            str(out_dir),
            str(input_path),
        ]
        res = subprocess.run(
            cmd,
            timeout=90,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        expected = out_dir / f"{input_path.stem}.{target_ext}"
        if res.returncode == 0 and expected.exists() and expected.stat().st_size > 0:
            if expected != output_path:
                shutil.move(str(expected), str(output_path))
            return True
        return False
    except Exception:
        return False
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)
