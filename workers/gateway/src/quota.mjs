export async function reserveQuota(storage, { client, perHour, daily, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10);
  return storage.transaction(async transaction => {
    const previous = await transaction.get("day");
    const state = previous?.day === day ? previous : { day, count: 0 };
    if (state.count >= daily) {
      return { ok: false, reason: "the model has answered all the questions it can today; try again tomorrow (UTC)" };
    }
    const hourly = {};
    for (const [key, timestamps] of Object.entries(state.hourly ?? {})) {
      const retained = timestamps.filter(timestamp => now - timestamp < 3600000);
      if (retained.length) hourly[key] = retained;
    }
    const times = Object.hasOwn(hourly, client) ? hourly[client] : [];
    if (times.length >= perHour) {
      return { ok: false, reason: "too many questions this hour; try again later" };
    }
    // Keep the legacy daily count while adding hourly history in the same transaction.
    await transaction.put("day", {
      day, count: state.count + 1, hourly: { ...hourly, [client]: [...times, now] },
    });
    return { ok: true };
  });
}
