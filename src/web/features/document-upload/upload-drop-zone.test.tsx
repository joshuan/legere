import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { UploadDropZone } from './document-upload';

// jsdom implements no drag-and-drop at all: there is no `DragEvent` constructor and nothing produces
// a `DataTransfer`. So the events are built by hand and dispatched at the window, which is where the
// zone listens — that is the whole surface under test, and driving it this way is the only way to
// reach it without a real browser.
function dragEvent(type: string, types: readonly string[], files: readonly File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = { types, files, dropEffect: 'none' };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

const FILE_DRAG = ['Files'];
const TEXT_DRAG = ['text/plain'];

const HINT = enMessages.documents.upload.hint;

// A raw `dispatchEvent` is not one of Testing Library's own calls, so React schedules the state it
// causes and does not flush it before the next line runs. `act` is what makes the assertion see the
// render the event caused.
function drag(event: Event): void {
  act(() => {
    window.dispatchEvent(event);
  });
}

function mount(onFiles: (file: File) => void = vi.fn()): void {
  renderWithProviders(
    <UploadDropZone onFiles={onFiles}>
      <p>the grid</p>
    </UploadDropZone>,
  );
}

describe('UploadDropZone', () => {
  it('renders what it wraps and says nothing until something is dragged', () => {
    mount();

    expect(screen.getByText('the grid')).toBeInTheDocument();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('says it will take the file, wherever on the page the drag is', () => {
    mount();

    drag(dragEvent('dragenter', FILE_DRAG));

    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  // 🔒 The flicker this guards against: `dragleave` fires the moment the pointer crosses into a
  // child, so a zone that believes one leave lowers the overlay in the middle of a drag.
  it('stays up while the drag crosses into a child of the page', () => {
    mount();

    drag(dragEvent('dragenter', FILE_DRAG));
    drag(dragEvent('dragenter', FILE_DRAG));
    drag(dragEvent('dragleave', FILE_DRAG));

    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('stops saying it when the drag finally leaves', () => {
    mount();

    drag(dragEvent('dragenter', FILE_DRAG));
    drag(dragEvent('dragleave', FILE_DRAG));

    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('stops saying it when the drag is abandoned', () => {
    mount();

    drag(dragEvent('dragenter', FILE_DRAG));
    drag(dragEvent('dragend', FILE_DRAG));

    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  // Promising an upload that cannot happen is worse than promising nothing.
  it('ignores a drag that carries no file', () => {
    mount();

    drag(dragEvent('dragenter', TEXT_DRAG));

    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('hands over every file that was dropped, and clears', () => {
    const onFiles = vi.fn<(file: File) => void>();
    mount(onFiles);
    const dropped = [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
    ];

    drag(dragEvent('dragenter', FILE_DRAG));
    drag(dragEvent('drop', FILE_DRAG, dropped));

    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onFiles.mock.calls.map(([file]) => file.name)).toEqual(['first.pdf', 'second.pdf']);
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  // Without this the browser reads the page as "not a drop target" and opens the file in the tab,
  // losing whatever the person was looking at.
  it('takes the browser default away from a file drag, and leaves a text drag its own', () => {
    mount();

    const over = dragEvent('dragover', FILE_DRAG);
    drag(over);
    expect(over.defaultPrevented).toBe(true);

    const text = dragEvent('dragover', TEXT_DRAG);
    drag(text);
    expect(text.defaultPrevented).toBe(false);
  });

  it('takes nothing over once it is gone', () => {
    const onFiles = vi.fn();
    const { unmount } = renderWithProviders(
      <UploadDropZone onFiles={onFiles}>
        <p>the grid</p>
      </UploadDropZone>,
    );

    unmount();
    drag(dragEvent('drop', FILE_DRAG, [new File(['x'], 'after.pdf', { type: 'application/pdf' })]));

    expect(onFiles).not.toHaveBeenCalled();
  });
});
