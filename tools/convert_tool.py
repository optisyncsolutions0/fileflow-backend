"""FileFlow helper for PDF and archive conversions.

Usage:
  convert_tool.py pdf2docx IN OUT
  convert_tool.py pdf2txt  IN OUT
  convert_tool.py pdf2md   IN OUT
  convert_tool.py pdf2html IN OUT
  convert_tool.py pdf2img  IN OUTDIR FORMAT      (prints one output path per line)
  convert_tool.py archive  IN IN_EXT OUT OUT_FMT

Errors meant for the user are printed as "USER_ERROR: ..." on stderr with exit code 2.
"""
import html
import io
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

MAX_IMAGE_PAGES = 50
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024  # 1 GB uncompressed


class UserError(Exception):
    pass


def open_pdf(path):
    import fitz  # PyMuPDF

    try:
        doc = fitz.open(path)
    except Exception:
        raise UserError("This PDF is damaged or not a real PDF file.")
    if doc.needs_pass:
        raise UserError("This PDF is password-protected. Remove the password and try again.")
    if doc.page_count == 0:
        raise UserError("This PDF has no pages.")
    return doc


def pdf_text_pages(path):
    doc = open_pdf(path)
    pages = [page.get_text("text").strip() for page in doc]
    if not any(pages):
        raise UserError(
            "This PDF has no selectable text (it is probably a scanned image). "
            "Try converting it to Word or JPG instead."
        )
    return pages


def pdf2docx(src, out):
    open_pdf(src).close()
    from pdf2docx import Converter

    cv = Converter(src)
    try:
        cv.convert(out)
    finally:
        cv.close()


def pdf2txt(src, out):
    pages = pdf_text_pages(src)
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n\n".join(pages) + "\n")


def pdf2md(src, out):
    pages = pdf_text_pages(src)
    parts = []
    for i, text in enumerate(pages, 1):
        paras = [" ".join(p.split()) for p in text.split("\n\n") if p.strip()]
        if not paras:
            paras = [line.strip() for line in text.splitlines() if line.strip()]
        parts.append(f"<!-- Page {i} -->\n\n" + "\n\n".join(paras))
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n\n---\n\n".join(parts) + "\n")


def pdf2html(src, out):
    doc = open_pdf(src)
    title = html.escape(os.path.splitext(os.path.basename(src))[0])
    body = []
    for i, page in enumerate(doc, 1):
        body.append(f'<section class="page" id="page-{i}">{page.get_text("xhtml")}</section>')
    with open(out, "w", encoding="utf-8") as f:
        f.write(
            "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">"
            f"<title>{title}</title><style>body{{font-family:sans-serif;max-width:900px;"
            "margin:2rem auto;padding:0 1rem;line-height:1.5}.page{border-bottom:1px solid #ddd;"
            "padding-bottom:2rem;margin-bottom:2rem}img{max-width:100%}</style></head><body>\n"
            + "\n".join(body)
            + "\n</body></html>\n"
        )


def pdf2img(src, outdir, fmt):
    import fitz

    doc = open_pdf(src)
    if doc.page_count > MAX_IMAGE_PAGES:
        raise UserError(f"PDF to image supports up to {MAX_IMAGE_PAGES} pages.")
    fmt = "jpg" if fmt == "jpeg" else fmt
    matrix = fitz.Matrix(2, 2)  # about 144 DPI
    width = len(str(doc.page_count))
    for i, page in enumerate(doc, 1):
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        path = os.path.join(outdir, f"page-{str(i).zfill(width)}.{fmt}")
        if fmt == "jpg":
            pix.save(path, jpg_quality=90)
        else:
            pix.save(path)
        print(path)


# ---------- archives ----------

def safe_name(name):
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


def iter_members(src, ext, tmp):
    """Yield (name, fileobj) for each regular file in the archive."""
    total = 0

    def count(size):
        nonlocal total
        total += size or 0
        if total > MAX_ARCHIVE_BYTES:
            raise UserError("Archive is too large to convert (over 1 GB unpacked).")

    if ext == "zip":
        try:
            zf = zipfile.ZipFile(src)
        except zipfile.BadZipFile:
            raise UserError("This ZIP file is damaged or not a real ZIP.")
        with zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if info.flag_bits & 0x1:
                    raise UserError("This ZIP is password-protected.")
                count(info.file_size)
                with zf.open(info) as f:
                    yield info.filename, f
        return

    if ext in ("tar", "tgz", "gz"):
        try:
            tf = tarfile.open(src, "r:*")
        except tarfile.TarError:
            tf = None
        if tf is not None:
            with tf:
                for m in tf:
                    if not m.isfile():
                        continue
                    count(m.size)
                    yield m.name, tf.extractfile(m)
            return
        if ext == "gz":
            import gzip

            name = os.path.basename(src)
            name = name[: -len(".gz")] if name.lower().endswith(".gz") else name + ".out"
            data = io.BytesIO()
            try:
                with gzip.open(src) as g:
                    while True:
                        chunk = g.read(1024 * 1024)
                        if not chunk:
                            break
                        count(len(chunk))
                        data.write(chunk)
            except OSError:
                raise UserError("This GZ file is damaged or not a real GZ.")
            data.seek(0)
            yield name, data
            return
        raise UserError("This TAR file is damaged or not a real TAR.")

    if ext == "7z":
        outdir = os.path.join(tmp, "x")
        os.makedirs(outdir)
        r = subprocess.run(["7z", "x", "-y", "-p", f"-o{outdir}", src], capture_output=True, text=True)
        if r.returncode != 0:
            raise UserError("This 7Z file is damaged or password-protected.")
        for root, _, files in os.walk(outdir):
            for fn in files:
                full = os.path.join(root, fn)
                if os.path.islink(full):
                    continue
                count(os.path.getsize(full))
                with open(full, "rb") as f:
                    yield os.path.relpath(full, outdir).replace(os.sep, "/"), f
        return

    raise UserError(f"{ext.upper()} archives are not supported.")


def archive(src, in_ext, out, out_fmt):
    with tempfile.TemporaryDirectory() as tmp:
        members = iter_members(src, in_ext, tmp)
        written = 0
        if out_fmt == "zip":
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
                for name, f in members:
                    name = safe_name(name)
                    if name:
                        with zf.open(name, "w", force_zip64=True) as dst:
                            shutil.copyfileobj(f, dst)
                        written += 1
        elif out_fmt in ("tar", "gz"):
            mode = "w:gz" if out_fmt == "gz" else "w"
            with tarfile.open(out, mode) as tf:
                for name, f in members:
                    name = safe_name(name)
                    if not name:
                        continue
                    data = f.read()
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mtime = int(time.time())
                    info.mode = 0o644
                    tf.addfile(info, io.BytesIO(data))
                    written += 1
        elif out_fmt == "7z":
            stage = os.path.join(tmp, "stage")
            os.makedirs(stage)
            for name, f in members:
                name = safe_name(name)
                if not name:
                    continue
                dest = os.path.join(stage, *name.split("/"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as dst:
                    shutil.copyfileobj(f, dst)
                written += 1
            if written:
                r = subprocess.run(["7z", "a", "-y", out, "."], cwd=stage, capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(r.stderr or r.stdout)
        else:
            raise UserError(f"Converting archives to {out_fmt.upper()} is not supported.")
        if written == 0:
            raise UserError("This archive is empty.")


def main(argv):
    cmd = argv[1]
    if cmd == "pdf2docx":
        pdf2docx(argv[2], argv[3])
    elif cmd == "pdf2txt":
        pdf2txt(argv[2], argv[3])
    elif cmd == "pdf2md":
        pdf2md(argv[2], argv[3])
    elif cmd == "pdf2html":
        pdf2html(argv[2], argv[3])
    elif cmd == "pdf2img":
        pdf2img(argv[2], argv[3], argv[4])
    elif cmd == "archive":
        archive(argv[2], argv[3], argv[4], argv[5])
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except UserError as e:
        print(f"USER_ERROR: {e}", file=sys.stderr)
        sys.exit(2)
