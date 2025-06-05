let sortingTimeout = null;
let sortPending = false;
let isSorting = false;

browser.tabs.onCreated.addListener((tab) => {
	if (tab.url && !isFirefoxInternal(tab.url)) {
		scheduleSorting();
	}
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.url && !isFirefoxInternal(changeInfo.url)) {
		scheduleSorting();
	}
});

browser.runtime.onMessage.addListener((message) => {
	if (message.action === "sortTabs") {
		sortTabs();
	}
});

// Listen for container changes
browser.contextualIdentities.onCreated.addListener(() => scheduleSorting());
browser.contextualIdentities.onUpdated.addListener(() => scheduleSorting());
browser.contextualIdentities.onRemoved.addListener(() => scheduleSorting());

// Listen for preference changes
browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName === "local") {
		if (
			Object.prototype.hasOwnProperty.call(changes, "containerOrder") ||
			Object.prototype.hasOwnProperty.call(changes, "sortTabsInGroup") ||
			Object.prototype.hasOwnProperty.call(changes, "tabSortCriteria")
		) {
			scheduleSorting();
		}
	}
});

function scheduleSorting() {
	if (sortingTimeout) {
		clearTimeout(sortingTimeout);
	}
	sortingTimeout = setTimeout(() => {
		sortTabs();
	}, 500);
}

async function sortTabs() {
	if (isSorting) {
		sortPending = true;
		return;
	}
	isSorting = true;
	try {
		const tabs = await browser.tabs.query({ currentWindow: true });

		// Exclude extension and special tabs
		const filteredTabs = tabs.filter(
			(tab) =>
				!tab.url.startsWith("moz-extension://") &&
				!tab.url.startsWith("about:"),
		);

		const containers = await browser.contextualIdentities.query({});
		const containerMap = containers.reduce((map, container) => {
			map[container.cookieStoreId] = container;
			return map;
		}, {});

		// Load user preferences
		const prefs = await browser.storage.local.get({
			containerOrder: [],
			sortTabsInGroup: false,
			tabSortCriteria: "domain", // Can be 'title', 'url', or 'domain'
		});

		// Map container IDs to their desired order
		const containerOrderMap = {};
		prefs.containerOrder.forEach((id, index) => {
			containerOrderMap[id] = index;
		});

		// If no container order is set, use the order in which they were created
		if (prefs.containerOrder.length === 0) {
			containers.forEach((container, index) => {
				containerOrderMap[container.cookieStoreId] = index;
			});
		}

		// Separate pinned and unpinned tabs from the filtered list
		const pinnedTabs = filteredTabs.filter((tab) => tab.pinned);
		const unpinnedTabs = filteredTabs.filter((tab) => !tab.pinned);

		// Group tabs by container
		const containerGroups = {};
		unpinnedTabs.forEach(tab => {
			const cookieStoreId = tab.cookieStoreId || "firefox-default";
			if (!containerGroups[cookieStoreId]) {
				containerGroups[cookieStoreId] = [];
			}
			containerGroups[cookieStoreId].push(tab);
		});

		// Sort tabs within each container group if enabled
		if (prefs.sortTabsInGroup) {
			for (const cookieStoreId in containerGroups) {
				containerGroups[cookieStoreId].sort((a, b) => {
					let aValue = "";
					let bValue = "";

					if (prefs.tabSortCriteria === "title") {
						aValue = assureString(a.title).toLowerCase();
						bValue = assureString(b.title).toLowerCase();
					} else if (prefs.tabSortCriteria === "url") {
						aValue = assureString(a.url).toLowerCase();
						bValue = assureString(b.url).toLowerCase();
					} else if (prefs.tabSortCriteria === "domain") {
						aValue = getDomain(a.url);
						bValue = getDomain(b.url);
					}

					return aValue.localeCompare(bValue);
				});
			}
		}

		// Sort container groups by the user-defined order
		const sortedContainerIds = Object.keys(containerGroups).sort((a, b) => {
			const orderA = containerOrderMap[a] !== undefined ? containerOrderMap[a] : Number.MAX_SAFE_INTEGER;
			const orderB = containerOrderMap[b] !== undefined ? containerOrderMap[b] : Number.MAX_SAFE_INTEGER;
			return orderA - orderB;
		});

		// Move tabs in the correct order
		let currentIndex = pinnedTabs.length;
		for (const cookieStoreId of sortedContainerIds) {
			const containerTabs = containerGroups[cookieStoreId];
			const tabIds = containerTabs.map(tab => tab.id);

			if (tabIds.length > 0) {
				try {
					await browser.tabs.move(tabIds, { index: currentIndex });
					currentIndex += tabIds.length;
				} catch (e) {
					console.error(`Error moving tabs for container ${cookieStoreId}:`, e);
				}
			}
		}
	} catch (error) {
		console.error("Error sorting tabs in sortTabs():", error);
	} finally {
		isSorting = false;
		if (sortPending) {
			sortPending = false;
			sortTabs();
		}
	}
}

function getDomain(url) {
	if (!url) return "";
	try {
		const urlObject = new URL(url);
		return urlObject.hostname;
	} catch (e) {
		console.error("Error parsing URL:", e);
		return url;
	}
}

function isFirefoxInternal(url) {
	return url.startsWith("about:") || url.startsWith("moz-extension://");
}

function assureString(value) {
	if (typeof value === "string") {
		return value;
	}
	return "";
}
