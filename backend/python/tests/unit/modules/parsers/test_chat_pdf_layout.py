"""Interactive PDF parsing keeps native content without running learned layout."""
import io
from unittest.mock import patch

from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.modules.parsers.pdf.layout_pages import parse_pdf_layout
from app.modules.parsers.pdf.opencv_layout_analyzer import LayoutRegionType
from tests.support.pdf_samples import text_pdf


def test_chat_layout_reads_all_pages_without_starting_the_layout_model() -> None:
    with patch(
        "app.modules.parsers.pdf.opencv_layout_analyzer._detect_model_boxes",
        side_effect=AssertionError("Interactive attachments must not start model inference"),
    ) as model:
        pages = parse_pdf_layout(text_pdf(pages=2), use_layout_model=False)

    model.assert_not_called()
    assert [page.page_number for page in pages] == [1, 2]
    assert all(page.width > 0 and page.height > 0 for page in pages)
    assert all(any("quick brown fox" in region.text for region in page.regions) for page in pages)


def test_background_layout_still_uses_the_model() -> None:
    with patch(
        "app.modules.parsers.pdf.opencv_layout_analyzer._detect_model_boxes",
        return_value=None,
    ) as model:
        parse_pdf_layout(text_pdf())

    model.assert_called_once()


def test_chat_layout_preserves_table_values_and_embedded_images() -> None:
    stream = io.BytesIO()
    pdf = canvas.Canvas(stream, pagesize=(400, 500))
    for x in (30, 180, 330):
        pdf.line(x, 300, x, 360)
    for y in (300, 330, 360):
        pdf.line(30, y, 330, y)
    for x, y, value in ((40, 340, "Service"), (190, 340, "Total"), (40, 310, "Plan"), (190, 310, "1200 EUR")):
        pdf.drawString(x, y, value)
    pdf.drawImage(ImageReader(Image.new("RGB", (200, 100), "blue")), 30, 80, width=200, height=100)
    pdf.save()

    pages = parse_pdf_layout(stream.getvalue(), use_layout_model=False)
    tables = [r for r in pages[0].regions if r.type == LayoutRegionType.TABLE]
    images = [r for r in pages[0].regions if r.type == LayoutRegionType.IMAGE]
    assert any("1200 EUR" in str(table.table_grid) for table in tables)
    assert any(image.image_data for image in images)
