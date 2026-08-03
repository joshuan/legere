# Docling with the languages a document archive actually meets (docs/05 §5.5).
#
# The upstream image ships tesseract with `eng` and `osd` only, and its default OCR engine
# (RapidOCR) has no Cyrillic model at all — asked for Russian it silently falls back to the Chinese
# model set and returns mangled text with a confident-looking score. So: real tesseract language
# data, and Legere asks for the tesseract engine by name.
FROM quay.io/docling-project/docling-serve-cpu:latest

# tessdata_fast: a few MB per language, and the accuracy difference against the full models is not
# visible on document scans.
ARG TESSDATA_REF=main
ARG LANGUAGES="rus ukr srp srp_latn deu fra spa ita pol tur"

USER 0
RUN set -eu; \
    for lang in ${LANGUAGES}; do \
      curl -fsSL -o "/usr/share/tesseract/tessdata/${lang}.traineddata" \
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/${lang}.traineddata"; \
    done; \
    chmod 0644 /usr/share/tesseract/tessdata/*.traineddata; \
    tesseract --list-langs
USER 1001
