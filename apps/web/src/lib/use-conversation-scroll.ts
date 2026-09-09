import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import type { ConversationTurn } from "./conversation";

export function useConversationScroll(turns: readonly ConversationTurn[]) {
  // A fresh native scroll container also cancels in-flight keyboard/touch scrolls.
  const viewportKey = turns.at(-1)?.id;
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
  const geometryRef = useRef({ height: 0, width: 0, contentHeight: 0 });
  const latestTurnRef = useRef<string | undefined>(undefined);
  const touchY = useRef<number | null>(null);
  const [following, setFollowing] = useState(true);

  const followLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    geometryRef.current = {
      height: viewport.clientHeight,
      width: viewport.clientWidth,
      contentHeight: viewport.scrollHeight,
    };
    if (followingRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      lastTopRef.current = viewport.scrollTop;
    }
  }, []);

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const geometry = geometryRef.current;
    // Resizing/reflow can dispatch scroll before ResizeObserver runs. Preserve
    // follow intent in that case instead of treating the changed gap as input.
    if (
      followingRef.current &&
      (geometry.height !== viewport.clientHeight ||
        geometry.width !== viewport.clientWidth ||
        geometry.contentHeight !== viewport.scrollHeight)
    ) {
      followLatest();
      return;
    }
    const nearBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32;
    // An upward native animation starts inside the bottom tolerance. It must
    // not undo explicit pause intent before it has moved the full distance.
    const next =
      viewport.scrollHeight <= viewport.clientHeight ||
      (nearBottom && (followingRef.current || viewport.scrollTop > lastTopRef.current));
    lastTopRef.current = viewport.scrollTop;
    followingRef.current = next;
    setFollowing(next);
  }, [followLatest]);

  const pauseFollowing = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || viewport.scrollHeight <= viewport.clientHeight) return;
    followingRef.current = false;
    setFollowing(false);
  }, []);

  // Capture upward intent before a concurrent reflow can emit its scroll event.
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0 && !event.ctrlKey && !event.shiftKey) pauseFollowing();
    },
    [pauseFollowing],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
        return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        pauseFollowing();
    },
    [pauseFollowing],
  );
  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchY.current = event.touches.length === 1 ? event.touches[0].clientY : null;
  }, []);
  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const nextY = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (nextY !== null && touchY.current !== null && nextY > touchY.current) pauseFollowing();
      touchY.current = nextY;
    },
    [pauseFollowing],
  );

  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    followLatest();
    // The jump button disappears; retain keyboard focus within the conversation.
    viewportRef.current?.focus({ preventScroll: true });
  }, [followLatest]);

  useLayoutEffect(() => {
    // Submitting a new prompt is an explicit request to follow its answer.
    if (viewportKey !== latestTurnRef.current) {
      latestTurnRef.current = viewportKey;
      followingRef.current = true;
      setFollowing(true);
    }
    followLatest();
  }, [turns, viewportKey, followLatest]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(followLatest);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [followLatest, viewportKey]);

  return {
    viewportRef,
    contentRef,
    viewportKey,
    following,
    onScroll,
    onWheel,
    onKeyDown,
    onTouchStart,
    onTouchMove,
    jumpToLatest,
  };
}
