import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Focus stays on the combobox. The popup is portaled so narrow cards and
// disclosure panels cannot clip the options.
export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  required = false,
  invalid = false,
  describedBy = undefined,
  disabled = false,
  className = "",
}) {
  const id = useId();
  const trigger = useRef(null);
  const popup = useRef(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState(null);
  const chosenIndex = options.findIndex((option) => option.value === value);
  const chosen = chosenIndex >= 0 ? options[chosenIndex] : null;
  const enabled = options
    .map((option, index) => (option.disabled ? null : index))
    .filter((index) => index !== null);
  function move(index, delta) {
    if (!enabled.length) return 0;
    const current = enabled.indexOf(index);
    if (current < 0) return delta > 0 ? enabled[0] : enabled.at(-1);
    const next = (current + delta + enabled.length) % enabled.length;
    return enabled[next];
  }
  const place = useCallback(() => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 210), window.innerWidth - 24);
    const left = Math.max(
      12,
      Math.min(rect.left, window.innerWidth - width - 12),
    );
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upward = below < 220 && above > below;
    const height = Math.max(0, Math.min(260, upward ? above - 6 : below - 6));
    setPosition({
      left,
      width,
      top: upward ? undefined : rect.bottom + 6,
      bottom: upward ? window.innerHeight - rect.top + 6 : undefined,
      maxHeight: height,
    });
  }, []);
  function show(index = chosenIndex) {
    if (disabled || !enabled.length) return;
    place();
    setActive(options[index]?.disabled || index < 0 ? enabled[0] : index);
    setOpen(true);
  }
  function close(restore = false) {
    setOpen(false);
    if (restore) requestAnimationFrame(() => trigger.current?.focus());
  }
  function pick(index) {
    if (options[index]?.disabled) return;
    if (options[index].value !== value) onChange(options[index].value);
    close(true);
  }
  function onKeyDown(event) {
    if (disabled) return;
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close(true);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      if (open) setActive((old) => move(old, delta));
      else show(move(chosenIndex, delta));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const index = event.key === "Home" ? enabled[0] : enabled.at(-1);
      if (open) setActive(index);
      else show(index);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) pick(active);
      else show();
    }
  }
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (
        !trigger.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        setOpen(false);
    };
    const reposition = () => place();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, place]);
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);
  useEffect(() => {
    if (!open || !popup.current) return;
    const item = popup.current.querySelector(`[data-option-index="${active}"]`);
    if (!item) return;
    const top = item.offsetTop;
    if (top < popup.current.scrollTop) popup.current.scrollTop = top;
    else if (
      top + item.offsetHeight >
      popup.current.scrollTop + popup.current.clientHeight
    )
      popup.current.scrollTop =
        top + item.offsetHeight - popup.current.clientHeight;
  }, [active, open]);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        role="combobox"
        className={`pm-select-trigger ${className}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onKeyDown}
      >
        <span>{chosen?.label || "当前选项不可用"}</span>
        <ChevronDownIcon
          size={15}
          aria-hidden="true"
          className={open ? "is-open" : ""}
        />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            className="pm-select-menu"
            role="listbox"
            id={id}
            ref={popup}
            aria-label={ariaLabel}
            style={position}
          >
            {options.map((option, index) => (
              <button
                type="button"
                key={option.value}
                data-option-index={index}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={`${index === active ? "active" : ""} ${option.value === value ? "selected" : ""}`}
                onPointerMove={() => !option.disabled && setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  pick(index);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
