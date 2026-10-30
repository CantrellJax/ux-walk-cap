(() => {
	let active = false,
		nextFallback = 0;
	const raf = window.requestAnimationFrame.bind(window),
		caf = window.cancelAnimationFrame.bind(window),
		timers = new Map();
	document.addEventListener("uxw-companion-captions", (event) => {
		active = event.detail === true;
	});
	window.requestAnimationFrame = (callback) => {
		if (!active || !document.hidden) return raf(callback);
		const id = --nextFallback;
		const timer = setTimeout(() => {
			timers.delete(id);
			callback(performance.now());
		}, 16);
		timers.set(id, timer);
		return id;
	};
	window.cancelAnimationFrame = (id) => {
		if (timers.has(id)) {
			clearTimeout(timers.get(id));
			timers.delete(id);
		} else caf(id);
	};
})();
