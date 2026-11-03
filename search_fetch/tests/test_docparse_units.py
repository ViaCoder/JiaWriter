#!/usr/bin/env python3
"""Direct unit tests for the docparse parsers and CLI — real files generated on the fly
(text PDF, image PDF via Pillow, docx, xlsx, GBK CSV); there is no OCR.
Needs the venv (pypdf, openpyxl, Pillow). No network.
Run: python3 tests/test_docparse_units.py
"""
# Output capture.
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import config, docparse  # noqa: E402

# Scratch root inside the repository.
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"


def text_pdf(text: str) -> bytes:
    """A one-page PDF with a Helvetica text layer (byte offsets computed, valid xref)."""
    # Page content stream.
    stream = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode()
    # Objects 1–5.
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    # Assemble with offsets.
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
P_NS = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'


def zip_parts(parts: dict) -> bytes:
    """A zip with the given part names and XML texts."""
    # In-memory zip.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in parts.items():
            z.writestr(name, text)
    return buf.getvalue()


def word_doc(body: str, styles: str = "") -> bytes:
    """A docx with this body XML and, optionally, these style elements."""
    # document.xml and styles.xml only: all the reader looks at.
    parts = {"word/document.xml": f'<?xml version="1.0"?><w:document {W_NS}><w:body>{body}</w:body></w:document>'}
    if styles:
        parts["word/styles.xml"] = f'<?xml version="1.0"?><w:styles {W_NS}>{styles}</w:styles>'
    return zip_parts(parts)


def slide(shapes: str) -> str:
    """One slide XML with these shapes."""
    return f'<?xml version="1.0"?><p:sld {P_NS}><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>'


def shape(text: str, ph: str = "") -> str:
    """A text shape, optionally a placeholder of this type."""
    nv = f'<p:nvSpPr><p:nvPr><p:ph type="{ph}"/></p:nvPr></p:nvSpPr>' if ph else "<p:nvSpPr><p:nvPr/></p:nvSpPr>"
    paras = "".join(f"<a:p><a:r><a:t>{t}</a:t></a:r></a:p>" for t in text.split("|"))
    return f"<p:sp>{nv}<p:txBody>{paras}</p:txBody></p:sp>"


def docx_bytes(text: str) -> bytes:
    """A minimal docx with one paragraph."""
    # In-memory zip.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return buf.getvalue()


class DocparseUnitsTest(unittest.TestCase):
    def setUp(self):
        # Scratch HOME.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix="docparse-", dir=str(_TMP_ROOT)))
        self.patch = mock.patch.object(config, "HOME", self.home)
        self.patch.start()

    def tearDown(self):
        # Restore.
        self.patch.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def test_log(self):
        # Prefixed stderr line.
        with contextlib.redirect_stderr(io.StringIO()) as err:
            docparse._log("x")
        self.assertEqual(err.getvalue(), "[docparse] x\n")

    def test_host_is(self):
        # Label-aligned domain match.
        self.assertTrue(docparse._host_is("a.gov.cn", "gov.cn") and docparse._host_is("gov.cn", "gov.cn"))
        self.assertFalse(docparse._host_is("evilgov.cn", "gov.cn"))

    def test_iter_page_links(self):
        # Relative, escaped and redirect-wrapped links; script links skipped.
        html = ('<a href="/r.pdf">a</a><a href="javascript:x()">b</a><img src="i.png">'
                '<a href="https://www.google.com/url?q=https://t.example/x.docx&amp;sa=U">c</a>')
        self.assertEqual(list(docparse._iter_page_links(html, "https://s.example/p/")),
                         ["https://s.example/r.pdf", "https://s.example/p/i.png", "https://t.example/x.docx"])

    def test_zip_kind_and_magic_image(self):
        # OOXML kind from the folder; images by magic bytes.
        self.assertEqual(docparse._zip_kind(docx_bytes("x")), "docx")
        self.assertEqual(docparse._zip_kind(b"not a zip"), "")
        self.assertTrue(docparse._magic_image(b"\x89PNG\r\n") and docparse._magic_image(b"RIFF\0\0\0\0WEBPVP8 "))
        self.assertFalse(docparse._magic_image(b"%PDF-1.4"))

    def test_parse_pdf_text(self):
        # Text layer extracted; garbage gives "".
        self.assertIn("Hello JiaWriter", docparse._parse_pdf_text(text_pdf("Hello JiaWriter")))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_pdf_text(b"%PDF-broken"), "")

    def test_ooxml_part(self):
        # A part as a tree; a missing part is None; a DOCTYPE is refused.
        with zipfile.ZipFile(io.BytesIO(zip_parts({"a.xml": "<r><x/></r>", "b.xml": '<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>'}))) as z:
            self.assertEqual(docparse._ooxml_part(z, "a.xml").find("x").tag, "x")
            self.assertIsNone(docparse._ooxml_part(z, "none.xml"))
            with self.assertRaisesRegex(ValueError, "DOCTYPE"):
                docparse._ooxml_part(z, "b.xml")

    def test_docx_text_and_blocks(self):
        # Runs, tab and break; paragraphs of a cell joined by a space; blocks inside a content control.
        import xml.etree.ElementTree as ET
        body = ET.fromstring(f'<w:body {W_NS}><w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r></w:p>'
                             '<w:sdt><w:sdtContent><w:p><w:r><w:t>目录</w:t></w:r></w:p></w:sdtContent></w:sdt>'
                             '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>一</w:t></w:r></w:p><w:p><w:r><w:t>二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                             '<w:sectPr/></w:body>')
        blocks = list(docparse._docx_blocks(body))
        self.assertEqual([b.tag.split("}")[1] for b in blocks], ["p", "p", "tbl"])
        self.assertEqual(docparse._docx_text(blocks[0]), "甲\t乙\n丙")
        self.assertEqual(docparse._docx_text(blocks[2]), "一 二")

    def test_md_table(self):
        # Short rows are padded; the first row is the header.
        self.assertEqual(docparse._md_table([["a", "b"], ["c"]]), "| a | b |\n| --- | --- |\n| c |  |")

    def test_parse_docx(self):
        # Headings from style names (any style id, e.g. Chinese Word's "1"), a numbered item, a table, plain text.
        styles = ('<w:style w:styleId="1"><w:name w:val="heading 1"/></w:style>'
                  '<w:style w:styleId="Title"><w:name w:val="Title"/></w:style>')
        body = ('<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>报告</w:t></w:r></w:p>'
                '<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>一、背景</w:t></w:r></w:p>'
                '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>'
                '<w:p><w:r><w:t>正文</w:t></w:r></w:p><w:p/>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>地区</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>'
                '<w:tr><w:tc><w:p><w:r><w:t>温州</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
        self.assertEqual(docparse._parse_docx(word_doc(body, styles)),
                         "# 报告\n\n# 一、背景\n\n- 第一项\n\n正文\n\n| 地区 | 数量 |\n| --- | --- |\n| 温州 | 12 |")
        # The one-paragraph fixture; junk and a DOCTYPE give "".
        self.assertEqual(docparse._parse_docx(docx_bytes("报告正文")), "报告正文")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_docx(b"junk"), "")
            self.assertEqual(docparse._parse_docx(zip_parts({"word/document.xml": "<!DOCTYPE x><x/>"})), "")
        self.assertEqual(docparse._parse_docx(zip_parts({"other.xml": "<x/>"})), "")

    def pptx(self) -> bytes:
        """A deck whose presentation order (slide2 first) differs from the file names, with a table and notes."""
        table = ('<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>项目</a:t></a:r></a:p></a:txBody></a:tc>'
                 '<a:tc><a:txBody><a:p><a:r><a:t>金额</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>')
        return zip_parts({
            "ppt/presentation.xml": f'<?xml version="1.0"?><p:presentation {P_NS}><p:sldIdLst>'
                                    '<p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId8"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels": f'<Relationships {REL_NS}><Relationship Id="rId8" Type="x/slide" Target="slides/slide1.xml"/>'
                                               '<Relationship Id="rId9" Type="x/slide" Target="/ppt/slides/slide2.xml"/></Relationships>',
            "ppt/slides/slide2.xml": slide(shape("开场", "ctrTitle") + shape("第一行|第二行")),
            "ppt/slides/slide1.xml": slide(shape("数据", "title") + table),
            "ppt/slides/_rels/slide1.xml.rels": f'<Relationships {REL_NS}><Relationship Id="rId2" '
                                                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" '
                                                'Target="../notesSlides/notesSlide1.xml"/></Relationships>',
            "ppt/notesSlides/notesSlide1.xml": slide(shape("讲到这里停一下", "body") + shape("2", "sldNum")),
        })

    def test_pptx_shapes_and_part_rels(self):
        # Blocks of a slide in order; relationships resolved relative to the part, "/" targets absolute.
        import xml.etree.ElementTree as ET
        blocks = docparse._pptx_shapes(ET.fromstring(slide(shape("题", "title") + shape("  ") + shape("文"))))
        self.assertEqual(blocks, [("title", "题"), ("text", "文")])
        with zipfile.ZipFile(io.BytesIO(self.pptx())) as z:
            self.assertEqual(docparse._part_rels(z, "ppt/presentation.xml"),
                             {"rId8": ("x/slide", "ppt/slides/slide1.xml"), "rId9": ("x/slide", "ppt/slides/slide2.xml")})
            self.assertEqual(docparse._part_rels(z, "ppt/slides/slide2.xml"), {})

    def test_parse_pptx(self):
        # Presentation order, titles, text, table and notes (the slide-number placeholder left out).
        self.assertEqual(docparse._parse_pptx(self.pptx()),
                         "<!-- Slide number: 1 -->\n\n# 开场\n\n第一行\n第二行\n\n"
                         "<!-- Slide number: 2 -->\n\n# 数据\n\n| 项目 | 金额 |\n| --- | --- |\n\n### Notes:\n讲到这里停一下")
        # Junk and a deck without presentation.xml give "".
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_pptx(b"junk"), "")
        self.assertEqual(docparse._parse_pptx(zip_parts({"ppt/x.xml": "<x/>"})), "")
        # parse_bytes routes both kinds.
        self.assertEqual(docparse.parse_bytes(self.pptx(), "pptx")["kind"], "pptx")
        self.assertEqual(docparse.parse_bytes(docx_bytes("字"), "docx")["text"], "字")

    def test_parse_xlsx(self):
        # Every sheet with its non-empty rows.
        import openpyxl
        wb = openpyxl.Workbook()
        wb.active.title = "数据"
        wb.active.append(["地区", "数量"])
        wb.active.append(["温州", 12])
        wb.active.append([None, None])
        buf = io.BytesIO()
        wb.save(buf)
        self.assertEqual(docparse._parse_xlsx(buf.getvalue()), "## 数据\n地区 | 数量\n温州 | 12")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_xlsx(b"junk"), "")

    def test_parse_csv_gbk(self):
        # GBK falls back cleanly.
        self.assertEqual(docparse._parse_csv("地区,数量\n温州,12\n".encode("gbk")), "地区,数量\n温州,12")

    def test_parse_bytes_without_ocr(self):
        # A text PDF gives its text; an image-only PDF and a picture give none (there is no OCR).
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (200, 100), "white").save(buf, format="PDF")
        self.assertEqual(docparse.parse_bytes(text_pdf("Layer"), "pdf"), {"text": "Layer", "kind": "pdf", "chars": 5})
        self.assertEqual(docparse.parse_bytes(buf.getvalue(), "pdf")["text"], "")
        self.assertEqual(docparse.parse_bytes(b"\x89PNG", "image")["text"], "")

    def test_try_fetch_document_scanned_is_none(self):
        # A downloaded scanned PDF has no text layer: None hands the URL back to the browser path.
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (200, 100), "white").save(buf, format="PDF")
        with mock.patch.object(docparse, "_http_get", return_value=(buf.getvalue(), "application/pdf", "https://example.com/s.pdf", "")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(docparse.try_fetch_document("https://example.com/s.pdf"))
        # A text PDF comes back with its kind and length.
        with mock.patch.object(docparse, "_http_get", return_value=(text_pdf("Body"), "application/pdf", "https://example.com/t.pdf", "")), \
                contextlib.redirect_stderr(io.StringIO()):
            doc = docparse.try_fetch_document("https://example.com/t.pdf", keep_bytes=True)
        self.assertEqual((doc["text"], doc["meta"], doc["final_url"]), ("Body", {"kind": "pdf", "chars": 4}, "https://example.com/t.pdf"))
        self.assertTrue(doc["data"].startswith(b"%PDF"))

    def test_main_cli(self):
        # Usage, a text PDF on disk, an unsupported file and a URL.
        pdf = self.home / "a.pdf"
        pdf.write_bytes(text_pdf("CLI text"))
        (self.home / "b.xyz").write_bytes(b"x")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._main([]), 2)
            self.assertEqual(docparse._main([str(self.home / "b.xyz")]), 1)
        # A text PDF on disk: its text layer as JSON, with kind and length only.
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(docparse._main([str(pdf), "--json"]), 0)
        self.assertEqual(json.loads(out.getvalue())["meta"], {"kind": "pdf", "chars": 8})
        self.assertIn("CLI text", json.loads(out.getvalue())["markdown"])
        with mock.patch.object(docparse, "try_fetch_document",
                               return_value={"final_url": "u", "text": "网页文档", "meta": {}}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(docparse._main(["https://example.com/r"]), 0)
        self.assertEqual(out.getvalue(), "网页文档\n")


if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nDOCPARSE UNITS:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
