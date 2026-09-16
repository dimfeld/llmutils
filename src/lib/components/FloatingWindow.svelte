<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    minimized,
    layer,
    onfocus,
    onminimize,
    onclose,
    children,
  }: {
    title: string;
    minimized: boolean;
    layer: number;
    onfocus: () => void;
    onminimize: () => void;
    onclose: () => void;
    children: Snippet;
  } = $props();

  let panel: HTMLDivElement;
  let x = $state(0);
  let y = $state(0);
  let width = $state<number>();
  let height = $state<number>();
  let gesture:
    | {
        kind: 'move' | 'resize';
        x: number;
        y: number;
        left: number;
        top: number;
        width: number;
        height: number;
      }
    | undefined;

  function constrain(): void {
    if (!panel?.offsetWidth) return;
    x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight));
  }

  function start(event: PointerEvent, kind: 'move' | 'resize'): void {
    if (event.button !== 0) return;
    event.preventDefault();
    onfocus();
    const rect = panel.getBoundingClientRect();
    gesture = {
      kind,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const handle = event.currentTarget as HTMLElement;
    handle.focus();
    handle.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent): void {
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.kind === 'move') {
      x = gesture.left + dx;
      y = gesture.top + dy;
      constrain();
    } else {
      width = Math.max(0, Math.min(window.innerWidth - x, gesture.width + dx));
      height = Math.max(0, Math.min(window.innerHeight - y, gesture.height + dy));
    }
  }

  function observeSize(node: HTMLDivElement): () => void {
    const observer = new ResizeObserver(constrain);
    observer.observe(node);
    return () => observer.disconnect();
  }

  function stop(): void {
    gesture = undefined;
  }

  function keyboard(event: KeyboardEvent, kind: 'move' | 'resize'): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const dx = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const dy = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (kind === 'move') {
      x += dx;
      y += dy;
      constrain();
    } else {
      width = Math.max(0, Math.min(window.innerWidth - x, panel.offsetWidth + dx));
      height = Math.max(0, Math.min(window.innerHeight - y, panel.offsetHeight + dy));
    }
  }
</script>

<svelte:window onresize={constrain} />

<div
  bind:this={panel}
  {@attach observeSize}
  role="region"
  aria-label={title}
  class="floating-window pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
  class:minimized
  style:left="{x}px"
  style:top="{y}px"
  style:width={width === undefined ? undefined : `${width}px`}
  style:height={height === undefined ? undefined : `${height}px`}
  style:z-index={layer}
  onpointerdown={onfocus}
  onfocusin={onfocus}
>
  <div class="flex shrink-0 items-center border-b border-border bg-muted">
    <button
      type="button"
      class="min-w-0 flex-1 cursor-move touch-none truncate px-3 py-2 text-left text-sm font-medium"
      aria-label="Move {title}"
      title="Drag to move. Use arrow keys when focused."
      onpointerdown={(event) => start(event, 'move')}
      onpointermove={move}
      onpointerup={stop}
      onlostpointercapture={stop}
      onkeydown={(event) => keyboard(event, 'move')}>{title}</button
    >
    <button type="button" class="px-3 py-2" aria-label="Minimize {title}" onclick={onminimize}
      >−</button
    >
    <button
      type="button"
      class="px-3 py-2"
      aria-label="Close {title}"
      title="Close window; keep session running"
      onclick={onclose}>×</button
    >
  </div>
  <div class="flex min-h-0 flex-1 overflow-hidden">{@render children()}</div>
  <button
    type="button"
    class="absolute right-0 bottom-0 cursor-se-resize touch-none bg-muted px-1 text-muted-foreground"
    aria-label="Resize {title}"
    title="Drag to resize. Use arrow keys when focused."
    onpointerdown={(event) => start(event, 'resize')}
    onpointermove={move}
    onpointerup={stop}
    onlostpointercapture={stop}
    onkeydown={(event) => keyboard(event, 'resize')}>◢</button
  >
</div>

<style>
  .floating-window {
    position: fixed;
    width: 40rem;
    height: 70dvh;
    min-width: min(20rem, 100vw);
    min-height: min(12rem, 100dvh);
    max-width: 100vw;
    max-height: 100dvh;
  }
  .minimized {
    display: none;
  }
</style>
