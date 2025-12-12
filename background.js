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

browser.runtime.onMessage.addListener(async (message) => {
	if (message.action === "sortTabs") {
		await sortTabs();
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

		// Exclude extension and special tabs (with null check for tab.url)
		const filteredTabs = tabs.filter(
			(tab) =>
				tab.url &&
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

		// If no container order is set, use the order in which they were created and persist it
		if (prefs.containerOrder.length === 0) {
			const defaultOrder = containers.map((c) => c.cookieStoreId);
			prefs.containerOrder = defaultOrder;
			// Persist the default order so it's consistent across sessions
			await browser.storage.local.set({ containerOrder: defaultOrder });
			// Update the order map with the new defaults
			defaultOrder.forEach((id, index) => {
				containerOrderMap[id] = index;
			});
		}

		// Separate pinned and unpinned tabs from the filtered list
		const pinnedTabs = filteredTabs.filter((tab) => tab.pinned);
		const unpinnedTabs = filteredTabs.filter((tab) => !tab.pinned);

		const tabsWithContainers = unpinnedTabs.map((tab) => {
			const container = containerMap[tab.cookieStoreId];
			return {
				...tab,
				containerName: container ? container.name.toLowerCase() : null,
				containerOrder: container
					? containerOrderMap[container.cookieStoreId]
					: Number.POSITIVE_INFINITY,
			};
		});
		const sortedTabs = tabsWithContainers.sort((a, b) => {
			// Tabs without containers should always be at the end
			if (!a.containerName && b.containerName) return 1;
			if (a.containerName && !b.containerName) return -1;
			if (!a.containerName && !b.containerName) return a.index - b.index;

			// Sort by container order
			if (a.containerOrder !== b.containerOrder) {
				return a.containerOrder - b.containerOrder;
			}

			// If containers are the same, optionally sort tabs within the group
			if (prefs.sortTabsInGroup) {
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
			}

			// If sorting within groups is disabled or criteria are equal, maintain original order
			return a.index - b.index;
		});

		// Move unpinned tabs to start after pinned tabs
		const tabIds = sortedTabs.map((tab) => tab.id);
		try {
			await browser.tabs.move(tabIds, { index: pinnedTabs.length });
		} catch (e) {
			console.error("Error moving tabs:", e);
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
