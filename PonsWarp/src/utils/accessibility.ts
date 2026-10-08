// Stable callback ref: focus once when a result heading mounts, not on progress updates.
export const focusStageHeading = (heading: HTMLHeadingElement | null): void => {
  if (!heading) return;
  requestAnimationFrame(() => {
    if (!heading.isConnected) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
};
