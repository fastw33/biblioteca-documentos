"""Fixture de QA local. Requiere python-docx, python-pptx y openpyxl; no usa datos empresariales."""
from pathlib import Path
from docx import Document
from pptx import Presentation
from openpyxl import Workbook

target = Path(__file__).resolve().parents[1] / '.runtime' / 'preview-fixtures'
target.mkdir(parents=True, exist_ok=True)
document = Document()
document.add_heading('Brochure de verificación', 0)
document.add_paragraph('Primera versión. Comprobación de vista previa y conservación del original.')
document.add_page_break()
document.add_heading('Servicios comerciales', 1)
document.add_paragraph('Segunda página del documento de prueba.')
document.save(target / 'brochure.docx')
slides = Presentation()
for title, body in [('Presentación corporativa', 'Segunda versión del recurso compartido.'), ('Nuestros servicios', 'Comprobación de navegación entre diapositivas.')]:
    slide = slides.slides.add_slide(slides.slide_layouts[1])
    slide.shapes.title.text = title
    slide.placeholders[1].text = body
slides.save(target / 'presentacion.pptx')
book = Workbook()
sheet = book.active
sheet.title = 'Oferta'
sheet.append(['Servicio', 'Cantidad', 'Precio'])
sheet.append(['Servicio de prueba', 2, 50000])
sheet.append(['Total', '', '=B2*C2'])
book.save(target / 'oferta.xlsx')
print('Fixtures Office generados en .runtime/preview-fixtures.')
