const messages = { loading: "pictureLoading", missing: "pictureMissing", unsupported: "pictureUnsupported",
  invalid: "pictureInvalid", too_large: "pictureTooLarge", unavailable: "pictureUnavailable" };

/** Bind one preview to its DOM nodes, independently of property filtering. */
export function createPictureView(document) {
  const figure = document.getElementById("picture-preview");
  const frame = document.getElementById("picture-frame");
  const caption = document.getElementById("picture-caption");
  const status = document.getElementById("picture-status");
  const page = document.querySelector(".page");
  let snapshot, image, phase;

  /** Use the latest labels and filename even when an earlier decode finishes after relabeling. */
  function update() {
    frame.classList.toggle("has-image", phase === "ready");
    status.hidden = phase === "ready";
    status.textContent = snapshot.labels[messages[phase]] ?? "";
    caption.textContent = "";
    if (!image) return;
    image.alt = snapshot.title;
    image.hidden = phase !== "ready";
    if (phase !== "ready") return;
    const { mimeType, fileName } = snapshot.picture;
    const format = mimeType === "image/svg+xml" ? "SVG" : mimeType === "image/x-icon" ? "ICO"
      : mimeType.slice("image/".length).toUpperCase();
    const dimensions = `${image.naturalWidth} × ${image.naturalHeight}`;
    caption.textContent = `${format} · ${dimensions}`;
    image.title = `${fileName} · ${dimensions}`;
  }

  /** Reuse identical image bytes; removed images cannot publish late load/error events. */
  function render(next) {
    const previous = snapshot?.picture;
    const preview = next.picture;
    const unchanged = image && preview?.status === "ready" && previous?.status === "ready"
      && preview.mimeType === previous.mimeType && preview.data === previous.data;
    snapshot = next;
    figure.hidden = !preview;
    page.classList.toggle("with-picture", Boolean(preview));
    figure.setAttribute("aria-label", next.labels.picture);
    if (unchanged) { update(); return; }
    image?.remove();
    image = undefined;
    phase = preview?.status;
    if (phase !== "ready") { update(); return; }
    phase = "loading";
    const candidate = document.createElement("img");
    image = candidate;
    candidate.id = "picture-image";
    candidate.addEventListener("load", () => {
      if (image !== candidate || !candidate.isConnected) return;
      phase = "ready";
      update();
    });
    candidate.addEventListener("error", () => {
      if (image !== candidate || !candidate.isConnected) return;
      phase = "invalid";
      update();
    });
    frame.prepend(candidate);
    update();
    candidate.src = `data:${preview.mimeType};base64,${preview.data}`;
  }
  return { render };
}
