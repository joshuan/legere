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

# Captions for the pictures inside documents (DOCLING_PICTURE_DESCRIPTION). Empty by default and
# deliberately so: the weights are 513 MB, and on CPU one page with three small pictures took 17
# minutes — read docs/12 §12.4 before turning it on. To include the model:
#   --build-arg PICTURE_DESCRIPTION_MODEL=HuggingFaceTB/SmolVLM-256M-Instruct
# Docling looks for it under ~/.cache/docling/models as "<owner>--<repo>", which is the layout the
# download below writes. The onnx variants in these repos are another 2.8 GB and Docling loads the
# safetensors, so they are skipped.
ARG PICTURE_DESCRIPTION_MODEL=""
RUN set -eu; \
    if [ -n "${PICTURE_DESCRIPTION_MODEL}" ]; then \
      owner="${PICTURE_DESCRIPTION_MODEL%%/*}"; \
      repo="${PICTURE_DESCRIPTION_MODEL#*/}"; \
      python3 -c "import sys; from huggingface_hub import snapshot_download; \
snapshot_download(sys.argv[1], local_dir=sys.argv[2], ignore_patterns=['onnx/*'])" \
        "${PICTURE_DESCRIPTION_MODEL}" "/opt/app-root/src/.cache/docling/models/${owner}--${repo}"; \
      chown -R 1001:0 /opt/app-root/src/.cache; \
    fi
USER 1001
