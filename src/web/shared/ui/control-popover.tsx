'use client';

import { Button, Popover, type GetRef } from 'antd';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** A compact toolbar disclosure with a named trigger, active count and keyboard return path. */
export function ControlPopover({
  label,
  icon,
  count = 0,
  children,
}: {
  label: string;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<GetRef<typeof Button>>(null);
  const id = useId();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title={label}
      open={open}
      onOpenChange={setOpen}
      content={
        <div
          id={id}
          role="group"
          aria-label={label}
          className="legere-control-popup"
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      }
    >
      <Button
        ref={triggerRef}
        icon={<span aria-hidden>{icon}</span>}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onKeyDown={onKeyDown}
      >
        {label}
        {count > 0 && <span className="legere-filter-count">{count}</span>}
      </Button>
    </Popover>
  );
}
