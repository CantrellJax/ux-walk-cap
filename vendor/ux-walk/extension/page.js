(() => {
	let active = false;
	const raf = window.requestAnimationFrame.bind(window),
		caf = window.cancelAnimationFrame.bind(window),
		timers = new Set();
	document.addEventListener("uxw-companion-captions", (event) => {
		active = event.detail === true;
	});
	window.requestAnimationFrame = (callback) => {
		if (!active || !document.hidden) return raf(callback);
		const id = setTimeout(() => {
			timers.delete(id);
			callback(performance.now());
		}, 16);
		timers.add(id);
		return id;
	};
	window.cancelAnimationFrame = (id) => {
		if (timers.delete(id)) clearTimeout(id);
		else caf(id);
	};
})();
