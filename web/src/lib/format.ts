export const percent = (bps: number) => (bps / 100).toString();
export const formatAge = (secs: number) => secs < 90 ? `${secs} s` : secs < 5400 ? `${Math.round(secs / 60)} min` : `${Math.round(secs / 3600)} h`;
