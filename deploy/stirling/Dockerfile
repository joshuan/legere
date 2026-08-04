# Stirling with the tesseract languages a document archive actually meets (docs/05 §5.5).
#
# The upstream image carries `chi_sim deu eng fra osd por` and nothing else. Legere's default
# OCR_LANGUAGES is `rus+eng`, and a document already known to be Russian is sent as `rus` alone —
# which that image answers with "Invalid OCR languages format: none of the selected languages are
# valid" and no text at all. Docling was given its languages for the same reason (ADR-018); this is
# the same list, so an instance reads the same documents whichever parser it runs.
FROM stirlingtools/stirling-pdf:latest

# tessdata_fast: a few MB per language, and the accuracy difference against the full models is not
# visible on document scans.
ARG TESSDATA_REF=main
ARG LANGUAGES="rus ukr srp srp_latn deu fra spa ita pol tur"

# TESS_BASE_PATH is where this image's tesseract already looks; the default is what it holds today,
# for the day the variable stops being set.
RUN set -eu; \
    tessdata="${TESS_BASE_PATH:-/usr/share/tesseract-ocr/5/tessdata}"; \
    for lang in ${LANGUAGES}; do \
      curl -fsSL -o "${tessdata}/${lang}.traineddata" \
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/${lang}.traineddata"; \
    done; \
    chmod 0644 "${tessdata}"/*.traineddata; \
    tesseract --list-langs
