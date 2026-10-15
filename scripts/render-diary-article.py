#!/usr/bin/env python3
"""Render a concise research article Markdown file as a readable A4 PDF."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    LongTable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)


DASHES = str.maketrans({"\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-"})
TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$")
INLINE = re.compile(
    r"\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|(?<!\*)\*([^*]+)\*(?!\*)|`([^`]+)`"
)


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        (Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/arialbd.ttf"), Path("C:/Windows/Fonts/ariali.ttf")),
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf")),
    ]
    for regular, bold, italic in candidates:
        if regular.exists() and bold.exists() and italic.exists():
            pdfmetrics.registerFont(TTFont("Article", str(regular)))
            pdfmetrics.registerFont(TTFont("Article-Bold", str(bold)))
            pdfmetrics.registerFont(TTFont("Article-Italic", str(italic)))
            pdfmetrics.registerFontFamily("Article", normal="Article", bold="Article-Bold", italic="Article-Italic", boldItalic="Article-Bold")
            return "Article", "Article-Bold", "Article-Italic"
    raise RuntimeError("Arial or DejaVu Sans fonts were not found.")


def inline_markup(value: str) -> str:
    value = value.translate(DASHES)
    parts: list[str] = []
    offset = 0
    for match in INLINE.finditer(value):
        parts.append(escape(value[offset : match.start()]))
        label, target, bold, italic, code = match.groups()
        if label is not None:
            safe_label = escape(label)
            if re.match(r"^(https?://|mailto:)", target, re.IGNORECASE):
                safe_target = escape(target).replace('"', "&quot;")
                parts.append(f'<link href="{safe_target}" color="#2B526D"><u>{safe_label}</u></link>')
            else:
                parts.append(safe_label)
        elif bold is not None:
            parts.append(f"<b>{escape(bold)}</b>")
        elif italic is not None:
            parts.append(f"<i>{escape(italic)}</i>")
        else:
            parts.append(f'<font name="Article-Mono">{escape(code or "")}</font>')
        offset = match.end()
    parts.append(escape(value[offset:]))
    return "".join(parts)


def split_row(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.strip().replace("\\|", "|") for cell in value.split("|")]


def build_styles(font: str, bold: str, italic: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()["BodyText"]
    body = ParagraphStyle(
        "ArticleBody", parent=base, fontName=font, fontSize=10.7, leading=14.2,
        textColor=colors.HexColor("#20262B"), spaceAfter=6.3, alignment=TA_LEFT,
        allowWidows=0, allowOrphans=0,
    )
    return {
        "body": body,
        "title": ParagraphStyle("ArticleTitle", parent=body, fontName=bold, fontSize=20, leading=24, spaceBefore=0, spaceAfter=12, keepWithNext=True),
        "h1": ParagraphStyle("ArticleH1", parent=body, fontName=bold, fontSize=15.5, leading=19, spaceBefore=14, spaceAfter=5, keepWithNext=True),
        "h2": ParagraphStyle("ArticleH2", parent=body, fontName=bold, fontSize=12.3, leading=15.5, spaceBefore=10, spaceAfter=4, keepWithNext=True),
        "h3": ParagraphStyle("ArticleH3", parent=body, fontName=bold, fontSize=11, leading=14, spaceBefore=8, spaceAfter=3, keepWithNext=True),
        "quote": ParagraphStyle("ArticleQuote", parent=body, fontName=italic, leftIndent=9, rightIndent=8, borderColor=colors.HexColor("#B7C4CC"), borderWidth=0, borderPadding=0, textColor=colors.HexColor("#3B464E"), spaceBefore=1, spaceAfter=7),
        "cell": ParagraphStyle("TableCell", parent=body, fontSize=8.9, leading=11.2, spaceAfter=0, allowWidows=0, allowOrphans=0),
        "cell_header": ParagraphStyle("TableHeader", parent=body, fontName=bold, fontSize=9, leading=11.3, spaceAfter=0, textColor=colors.HexColor("#17232B")),
        "list": ParagraphStyle("ArticleList", parent=body, leftIndent=15, firstLineIndent=-9, spaceAfter=3.5),
        "code": ParagraphStyle("ArticleCode", parent=body, fontName="Article-Mono", fontSize=8.8, leading=11.2, leftIndent=10, rightIndent=6, spaceAfter=3),
    }


def parse_markdown(source: str, styles: dict[str, ParagraphStyle], page_width: float) -> list[object]:
    lines = source.translate(DASHES).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    story: list[object] = []
    i = 0
    title_used = False
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("```"):
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                story.append(Paragraph(escape(lines[i].translate(DASHES)), styles["code"]))
                i += 1
            i += int(i < len(lines))
            continue
        heading = re.match(r"^(#{1,3})\s+(.+?)\s*#*\s*$", line)
        if heading:
            level = len(heading.group(1))
            style = "title" if level == 1 and not title_used else f"h{level}"
            title_used = title_used or style == "title"
            story.append(Paragraph(inline_markup(heading.group(2)), styles[style]))
            i += 1
            continue
        if line in {"---", "***", "___"}:
            story.append(Spacer(1, 5))
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and TABLE_RULE.match(lines[i + 1]):
            header = split_row(line)
            rows: list[list[str]] = [header]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                row = split_row(lines[i])
                if len(row) < len(header):
                    row.extend([""] * (len(header) - len(row)))
                rows.append(row[: len(header)])
                i += 1
            widths = [page_width / max(1, len(header))] * len(header)
            table_data = [[Paragraph(inline_markup(cell), styles["cell_header"]) for cell in rows[0]]]
            table_data.extend([[Paragraph(inline_markup(cell), styles["cell"]) for cell in row] for row in rows[1:]])
            table = LongTable(table_data, colWidths=widths, repeatRows=1, hAlign="LEFT", splitByRow=1)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF2F4")),
                ("LINEBELOW", (0, 0), (-1, 0), 0.65, colors.HexColor("#9EABB3")),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#DCE2E6")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.extend([table, Spacer(1, 6)])
            continue
        if line.startswith(">"):
            quote_lines = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote_lines.append(lines[i].strip()[1:].strip())
                i += 1
            quote_text = "<br/>".join(inline_markup(text) for text in quote_lines)
            story.append(Paragraph(quote_text, styles["quote"]))
            continue
        if re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", lines[i]):
            while i < len(lines) and re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", lines[i]):
                marker = re.match(r"^\s*(?:([-*+])|(\d+[.)]))\s+", lines[i]).groups()
                item = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", lines[i].strip())
                bullet = "&#8226;" if marker[0] else escape(marker[1])
                story.append(Paragraph(f"{bullet}&nbsp;&nbsp;{inline_markup(item)}", styles["list"]))
                i += 1
            continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,3})\s+", lines[i].strip()) and not lines[i].strip().startswith((">", "|", "```")):
            paragraph.append(lines[i].strip())
            i += 1
        story.append(Paragraph(" ".join(inline_markup(text) for text in paragraph), styles["body"]))
    return story


def render(source_path: Path, output_path: Path) -> None:
    source = source_path.read_text(encoding="utf-8-sig")
    if not source.strip():
        raise ValueError("The Markdown input is empty.")
    regular, bold, italic = register_fonts()
    pdfmetrics.registerFont(TTFont("Article-Mono", str(Path("C:/Windows/Fonts/consola.ttf"))) if Path("C:/Windows/Fonts/consola.ttf").exists() else TTFont("Article-Mono", str(Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"))))
    styles = build_styles(regular, bold, italic)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    document = SimpleDocTemplate(
        str(output_path), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=19 * mm, bottomMargin=19 * mm, title=source_path.stem.replace("-", " ").title(),
        author="Level Workshop",
    )
    document.build(parse_markdown(source, styles, A4[0] - 40 * mm))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("markdown", type=Path, help="Input Markdown article")
    parser.add_argument("pdf", type=Path, help="Output PDF file")
    args = parser.parse_args()
    try:
        render(args.markdown, args.pdf)
    except Exception as error:
        print(f"PDF render failed: {error}", file=sys.stderr)
        return 1
    print(f"Rendered {args.pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
