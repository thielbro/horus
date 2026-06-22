type CameraFetcher<T = unknown> = () => Promise<T[]>;

function settleFetcher<T>(
  fetcher: CameraFetcher<T>,
  timeoutMs: number,
): Promise<PromiseSettledResult<T[]>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const fetchPromise = Promise.resolve().then(fetcher).then<PromiseSettledResult<T[]>, PromiseSettledResult<T[]>>(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );

  const timeoutPromise = new Promise<PromiseSettledResult<T[]>>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: 'rejected',
        reason: new Error(`CCTV source timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
  });

  return Promise.race([fetchPromise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function settleCameraFetchers<T>(
  fetchers: Array<CameraFetcher<T>>,
  timeoutMs = 25000,
): Promise<PromiseSettledResult<T[]>[]> {
  return Promise.all(fetchers.map((fetcher) => settleFetcher(fetcher, timeoutMs)));
}
