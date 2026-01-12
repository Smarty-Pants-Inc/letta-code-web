import { Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type TerminalViewHandle = {
  write: (data: string) => void;
  clear: () => void;
};

export const TerminalView = forwardRef<
  TerminalViewHandle,
  {
    onResize: (cols: number, rows: number) => void;
    onKey?: (data: string) => void;
  }
>(function TerminalView({ onResize, onKey }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollOverlayRef = useRef<HTMLDivElement | null>(null);
  const scrollOverlayContentRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onResizeRef = useRef(onResize);
  const onKeyRef = useRef(onKey);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onKeyRef.current = onKey;
  }, [onKey]);

  useImperativeHandle(ref, () => {
    return {
      write: (data) => terminalRef.current?.write(data),
      clear: () => terminalRef.current?.clear(),
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      reflowCursorLine: true,
      theme: {
        background: "#0b0b0f",
      },
      disableStdin: false,
      scrollback: 5000,
    });
    term.open(el);

    const fitTerminal = () => {
      if (!term.element || !term.element.parentElement) return;

      type XtermCore = {
        _renderService?: {
          dimensions?: {
            css?: { cell?: { width: number; height: number } };
          };
          clear?: () => void;
        };
      };

      const core = (term as unknown as { _core?: XtermCore })._core;

      const cellW = core?._renderService?.dimensions?.css?.cell?.width ?? 0;
      const cellH = core?._renderService?.dimensions?.css?.cell?.height ?? 0;
      if (!cellW || !cellH) return;

      const parentElementStyle = window.getComputedStyle(
        term.element.parentElement,
      );
      const parentElementHeight = Number.parseInt(
        parentElementStyle.getPropertyValue("height"),
        10,
      );
      const parentElementWidth = Math.max(
        0,
        Number.parseInt(parentElementStyle.getPropertyValue("width"), 10),
      );

      const elementStyle = window.getComputedStyle(term.element);
      const elementPaddingTop = Number.parseInt(
        elementStyle.getPropertyValue("padding-top"),
        10,
      );
      const elementPaddingBottom = Number.parseInt(
        elementStyle.getPropertyValue("padding-bottom"),
        10,
      );
      const elementPaddingLeft = Number.parseInt(
        elementStyle.getPropertyValue("padding-left"),
        10,
      );
      const elementPaddingRight = Number.parseInt(
        elementStyle.getPropertyValue("padding-right"),
        10,
      );

      const elementPaddingVer = elementPaddingTop + elementPaddingBottom;
      const elementPaddingHor = elementPaddingLeft + elementPaddingRight;

      const availableHeight = parentElementHeight - elementPaddingVer;
      const availableWidth = parentElementWidth - elementPaddingHor;

      const cols = Math.max(2, Math.floor(availableWidth / cellW));
      const rows = Math.max(1, Math.floor(availableHeight / cellH));
      if (term.rows === rows && term.cols === cols) return;

      core?._renderService?.clear?.();
      term.resize(cols, rows);
      onResizeRef.current(term.cols, term.rows);
    };

    fitTerminal();
    requestAnimationFrame(() => fitTerminal());

    const onWindowResize = () => fitTerminal();
    window.addEventListener("resize", onWindowResize);
    window.visualViewport?.addEventListener("resize", onWindowResize);
    void document.fonts?.ready.then(() => fitTerminal());

    const isCoarsePointer = Boolean(
      window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches,
    );

    let disposeScroll: (() => void) | null = null;

    if (isCoarsePointer) {
      // "Native" momentum scrolling: a real scrollable overlay that we map to
      // xterm's scroll position.
      const overlay = scrollOverlayRef.current;
      const overlayContent = scrollOverlayContentRef.current;

      if (overlay && overlayContent) {
        const getLineHeightPx = () => {
          const rowsEl = term.element?.querySelector(
            ".xterm-rows",
          ) as HTMLElement | null;
          const rect = rowsEl?.getBoundingClientRect();
          const h = rect?.height ?? 0;
          return term.rows > 0 && h > 0 ? h / term.rows : 12;
        };

        let isSyncing = false;
        let userScrollUntil = 0;

        const nowMs = () =>
          typeof performance !== "undefined" ? performance.now() : Date.now();

        const isNearBottom = () => {
          const slack = 6;
          const maxTop = overlay.scrollHeight - overlay.clientHeight;
          return overlay.scrollTop >= maxTop - slack;
        };

        const syncOverlayMetrics = () => {
          const lineH = getLineHeightPx();
          const totalLines = term.buffer.active.length;
          overlayContent.style.height = `${Math.max(1, totalLines) * lineH}px`;
        };

        const syncOverlayScrollTopFromTerminal = () => {
          if (nowMs() < userScrollUntil) return;
          const lineH = getLineHeightPx();
          isSyncing = true;
          const nextTop = term.buffer.active.viewportY * lineH;
          // Avoid stomping on iOS momentum scrolling.
          if (Math.abs(overlay.scrollTop - nextTop) >= 1) {
            overlay.scrollTop = nextTop;
          }
          requestAnimationFrame(() => {
            isSyncing = false;
          });
        };

        const onOverlayScroll = () => {
          if (isSyncing) return;
          userScrollUntil = nowMs() + 160;
          const lineH = getLineHeightPx();
          const baseY = term.buffer.active.baseY;
          const y = Math.max(
            0,
            Math.min(baseY, Math.round(overlay.scrollTop / lineH)),
          );
          term.scrollToLine(y);
        };

        const dispWrite = term.onWriteParsed(() => {
          syncOverlayMetrics();
          // Only auto-follow output if the user is already at the bottom.
          if (isNearBottom()) {
            syncOverlayScrollTopFromTerminal();
          }
        });
        const dispScroll = term.onScroll(() => {
          syncOverlayMetrics();
          syncOverlayScrollTopFromTerminal();
        });

        overlay.addEventListener("scroll", onOverlayScroll, { passive: true });
        syncOverlayMetrics();
        syncOverlayScrollTopFromTerminal();

        disposeScroll = () => {
          dispWrite.dispose();
          dispScroll.dispose();
          overlay.removeEventListener("scroll", onOverlayScroll);
        };
      }
    } else {
      // Desktop fallback: keep the old "terminal way" scroll for non-touch.
      const screen = term.element?.querySelector(
        ".xterm-screen",
      ) as HTMLElement | null;
      const scrollTarget = screen ?? term.element ?? el;

      let lastTouchY = 0;
      let scrollAcc = 0;
      const pixelsPerLine = 12;

      const onTouchStart = (ev: TouchEvent) => {
        if (ev.touches.length !== 1) return;
        lastTouchY = ev.touches[0]?.clientY ?? 0;
        scrollAcc = 0;
      };

      const onTouchMove = (ev: TouchEvent) => {
        if (ev.touches.length !== 1) return;
        const y = ev.touches[0]?.clientY ?? lastTouchY;
        const dy = y - lastTouchY;
        lastTouchY = y;

        ev.preventDefault();

        scrollAcc += -dy;
        const lines = Math.trunc(scrollAcc / pixelsPerLine);
        if (lines !== 0) {
          term.scrollLines(lines);
          scrollAcc -= lines * pixelsPerLine;
        }
      };

      scrollTarget.addEventListener("touchstart", onTouchStart, {
        passive: true,
      });
      scrollTarget.addEventListener("touchmove", onTouchMove, {
        passive: false,
      });

      disposeScroll = () => {
        scrollTarget.removeEventListener("touchstart", onTouchStart);
        scrollTarget.removeEventListener("touchmove", onTouchMove);
      };
    }

    terminalRef.current = term;

    const disp = term.onData((data) => {
      onKeyRef.current?.(data);
    });

    const ro = new ResizeObserver(() => {
      fitTerminal();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      disp.dispose();
      disposeScroll?.();
      window.removeEventListener("resize", onWindowResize);
      window.visualViewport?.removeEventListener("resize", onWindowResize);
      term.dispose();
      terminalRef.current = null;
    };
  }, []);

  return (
    <div ref={hostRef} className="terminalHost">
      <div ref={containerRef} className="terminalXterm" />
      <div
        ref={scrollOverlayRef}
        className="terminalScrollOverlay"
        aria-hidden="true"
      >
        <div ref={scrollOverlayContentRef} />
      </div>
    </div>
  );
});
