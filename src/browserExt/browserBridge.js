/* Local, opt-in CLI transport. Saving itself uses the normal toolbar action. */
Zotero.BrowserBridge = new class {
	async request(config, path, data) {
		const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
			method: data === undefined ? 'GET' : 'POST',
			headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
			signal: AbortSignal.timeout(10000)
		});
		if (!response.ok) throw new Error(`Browser bridge HTTP ${response.status}`);
		return response.json();
	}

	_tabStatus(tab) {
		const url = new URL(tab.url);
		const info = Zotero.Connector_Browser.getTabInfo(tab.id);
		const challenge = /just a moment|attention required|access denied|verify (you|that)|captcha|security check|robot check/i.test(tab.title || '');
		return { id: tab.id, title: tab.title, url: url.origin + url.pathname,
			state: challenge ? 'needs_user_action' : (tab.status === 'complete' && (info.detectionDone || info.isPDF || info.uninjectable) ? 'ready' : 'loading'),
			translators: (info.translators || []).map(t => t.label), isPDF: !!info.isPDF };
	}

	async _openOrGet(request, context) {
		let tab;
		if (request.url) {
			const url = new URL(request.url);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
				throw new Error('Select an HTTP(S) publication URL without credentials');
			}
			tab = await browser.tabs.create({url: request.url, active: !request.background});
			context.createdTabId = tab.id;
		}
		else {
			tab = await browser.tabs.get(request.tab_id);
		}
		const seconds = request.ready_timeout ?? 30;
		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0.5 || seconds > 120) {
			throw new Error('ready_timeout must be between 0.5 and 120 seconds');
		}
		const needsTranslator = request.action === 'save' && request.require_pdf !== false;
		for (let n = 0; n < Math.ceil(seconds * 4); n++) {
			tab = await browser.tabs.get(tab.id);
			if (/^https?:/.test(tab.url)) {
				const page = this._tabStatus(tab);
				// An empty detection callback can precede late metadata or a frame's
				// translator. Page readiness alone is insufficient for a PDF save.
				if (page.state === 'ready' && (!needsTranslator || page.isPDF || page.translators.length)) return tab;
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		return tab;
	}

	async execute(request) {
		const context = {activated: new Set()};
		const onActivated = ({tabId}) => context.activated.add(tabId);
		browser.tabs.onActivated.addListener(onActivated);
		try {
			const result = await this._execute(request, context);
			if (result.tab) result.tab.createdByRequest = context.createdTabId === result.tab.id;
			if (request.close_on_success && result.tab) {
				result.tab.closed = false;
				if (!result.ok) result.tab.closeReason = 'save_not_confirmed';
				else if (context.createdTabId !== result.tab.id) result.tab.closeReason = 'existing_tab';
				else {
					try {
						const tab = await browser.tabs.get(context.createdTabId);
						if (context.activated.has(tab.id) || tab.active || tab.pinned || tab.url !== context.savedURL) {
							result.tab.closeReason = 'tab_changed_or_activated';
						}
						else {
							await browser.tabs.remove(tab.id);
							result.tab.closed = true;
						}
					}
					catch (_) {
						// Cleanup must not turn a confirmed save into a retryable failure.
						result.tab.closeReason = 'cleanup_unavailable';
					}
				}
			}
			return result;
		}
		catch (error) {
			if (context.createdTabId === undefined) throw error;
			return {ok: false, state: 'outcome_unknown',
				tab: {id: context.createdTabId, createdByRequest: true, closed: false},
				error: 'Connector could not complete the request; inspect this tab and Zotero before retrying'};
		}
		finally {
			browser.tabs.onActivated.removeListener(onActivated);
		}
	}

	async _execute(request, context) {
		if (request.action === 'tabs') {
			const tabs = await browser.tabs.query({});
			return { ok: true, tabs: tabs.filter(t => /^https?:/.test(t.url)).map(t => {
				const url = new URL(t.url);
				// Query strings can contain publisher access tokens.
				return { id: t.id, title: t.title, url: url.origin + url.pathname, active: t.active };
			}) };
		}
		if (request.action === 'focus') {
			const tab = await browser.tabs.get(request.tab_id);
			if (!/^https?:/.test(tab.url)) throw new Error('Select an HTTP(S) publication tab');
			await browser.tabs.update(tab.id, {active: true});
			await browser.windows.update(tab.windowId, {focused: true});
			return {ok: true, tab: this._tabStatus(tab)};
		}
		if (request.action === 'inspect') {
			const tab = await browser.tabs.get(request.tab_id);
			if (!/^https?:/.test(tab.url)) throw new Error('Select an HTTP(S) publication tab');
			return {ok: true, tab: this._tabStatus(tab)};
		}
		if (request.action === 'open') {
			return {ok: true, tab: this._tabStatus(await this._openOrGet(request, context))};
		}
		if (!await Zotero.Connector.checkIsOnline()) {
			throw new Error('Open Zotero desktop before using browser CLI saving');
		}
		const selected = await Zotero.Connector.callMethod('getSelectedCollection', {});
		const target = selected.id ? `C${selected.id}` : `L${selected.libraryID}`;
		if (request.action === 'targets') {
			return { ok: true, selected: target, libraryID: selected.libraryID,
				libraryName: selected.libraryName, targets: selected.targets, capabilities: ['destination', 'ready_timeout'] };
		}
		if (request.action !== 'save') throw new Error('Unknown browser action');
		if (request.target && request.target !== target) {
			throw new Error(`Select ${request.target} in Zotero first (currently ${target}); no save was started`);
		}
		if (!selected.libraryEditable || selected.filesEditable === false) {
			throw new Error('The selected Zotero target does not allow saving files');
		}
		if (request.destination) {
			const destination = selected.targets?.find(t => t.id === request.destination);
			if (!destination || destination.filesEditable !== true) {
				throw new Error('Select a writable destination from browser targets; no save was started');
			}
		}
		if (Zotero.Prefs.get('firstUse')) {
			throw new Error('Complete the Connector first-use prompt with its toolbar button first');
		}
		const tab = await this._openOrGet(request, context);
		if (!/^https?:/.test(tab.url)) throw new Error('Select an HTTP(S) publication tab');
		const page = this._tabStatus(tab);
		context.savedURL = tab.url;
		if (page.state !== 'ready') {
			return {ok: false, tab: page, state: page.state,
				error: 'Connector page needs attention or is still loading; resolve it in the browser, then save the same tab ID'};
		}
		const info = Zotero.Connector_Browser.getTabInfo(tab.id);
		if (request.defer_user_action && info.translators?.[0]?.itemType === 'multiple') {
			return {ok: false, tab: page, state: 'needs_user_action',
				error: 'Connector item selection is required; deferred without starting a save'};
		}
		if (request.require_pdf !== false && !info.translators?.length && !info.isPDF) {
			return {ok: false, tab: page, state: 'loading', waitingFor: 'translator',
				error: 'Publication translator was not detected within the readiness budget; inspect this same tab before retrying. It may be slow or unsupported'};
		}
		if (!info.detectionDone && !info.isPDF && !info.uninjectable) {
			throw new Error('Connector detection is not ready; reload the publication tab and retry');
		}
		// Opening a URL and publisher verification may take time. Recheck the
		// destination immediately before invoking the write, not only before navigation.
		const beforeSave = await Zotero.Connector.callMethod('getSelectedCollection', {});
		const beforeTarget = beforeSave.id ? `C${beforeSave.id}` : `L${beforeSave.libraryID}`;
		if (beforeTarget !== target) {
			return {ok:false,tab:page,error:'Zotero target changed while the publication loaded; no save was started'};
		}
		const saved = await Zotero.Connector_Browser.onZoteroButtonElementClick(tab, { cliSave: true });
		if (!saved || !saved.sessionID || !saved.desktopSaved) {
			throw new Error('Connector returned no save receipt. The outcome is unknown; inspect Zotero before retrying');
		}
		let after = await Zotero.Connector.callMethod('getSelectedCollection', {});
		let afterTarget = after.id ? `C${after.id}` : `L${after.libraryID}`;
		let result = { ...saved, tab: page, selectedTarget: afterTarget, libraryID: after.libraryID, libraryName: after.libraryName };
		if (afterTarget !== target || saved.target !== target) {
			return { ...result, ok: false, error: 'Zotero target changed during saving; inspect the saved items before retrying' };
		}
		if (request.destination) {
			result.destination = request.destination;
			result.destinationApplied = false;
			if (saved.sessionReused && saved.target !== request.destination) {
				return {...result, ok: false, error: 'Connector session was already saved; inspect existing items before changing its destination'};
			}
			try {
				if (saved.target !== request.destination) {
					// Move the completed session through the popup's native path. Wait for
					// attachments first so cross-library moves cannot race their uploads.
					await Zotero.Connector.callMethod('updateSession', {
						sessionID: saved.sessionID, target: request.destination,
						tags: saved.sessionTags || [], note: saved.sessionNote || ''
					});
				}
				after = await Zotero.Connector.callMethod('getSelectedCollection', {});
				afterTarget = after.id ? `C${after.id}` : `L${after.libraryID}`;
				result = {...result, selectedTarget: afterTarget, libraryID: after.libraryID, libraryName: after.libraryName};
				if (afterTarget !== request.destination) {
					return {...result, ok: false, error: 'Connector destination confirmation failed; inspect this session before retrying'};
				}
				result.target = request.destination;
				result.destinationApplied = true;
			}
			catch (_) {
				return {...result, ok: false, error: 'Connector destination update failed or is uncertain; items may remain at the initial target'};
			}
		}
		// A translator can create metadata even when every PDF fails. Require a
		// stored PDF for each returned item, not just a candidate URL or link.
		if (request.require_pdf !== false && (!result.items?.length || result.items.some(item =>
			!item.attachments?.some(a => a.mimeType === 'application/pdf' && a.stored === true)))) {
			return { ...result, ok: false, error: 'Metadata may be saved, but a stored PDF was not confirmed for every item' };
		}
		return { ...result, ok: true };
	}

	async start() {
		if (this.started) return;
		this.started = true;
		while (true) {
			try {
				const stored = await browser.storage.local.get(['browserBridge', 'browserBridgePending']);
				const config = stored.browserBridge;
				if (config?.enabled && /^[A-Za-z0-9_-]{32,}$/.test(config.token)
					&& Number.isInteger(config.port) && config.port > 0 && config.port < 65536) {
					const status = await this.request(config, '/status');
					let pending = stored.browserBridgePending;
					if (pending && pending.brokerID !== status.brokerID) {
						await browser.storage.local.set({browserBridgeLostReceipt: pending});
						await browser.storage.local.remove('browserBridgePending');
						pending = null;
					}
					if (pending) {
						// A worker restart during a save cannot safely replay the click.
						const result = pending.result || { ok: false,
							error: 'Connector restarted during this save; outcome unknown. Inspect Zotero before retrying' };
						await this.request(config, `/jobs/${pending.id}`, { client: config.client, result });
						await browser.storage.local.remove('browserBridgePending');
					}
					const response = await this.request(config, '/poll', { client: config.client });
					if (response.protocol !== 1) throw new Error('Unsupported bridge protocol');
					if (response.job) {
						pending = { id: response.job.id, brokerID: response.brokerID };
						await browser.storage.local.set({ browserBridgePending: pending });
						try {
							pending.result = await this.execute(response.job.request);
						}
						catch (error) {
							// Do not relay publisher URLs, response bodies or credentials.
							pending.result = { ok: false, error: error.message.startsWith('Select ')
								|| error.message.startsWith('Connector ') || error.message.startsWith('Open ')
								|| error.message.startsWith('Complete ') || error.message.startsWith('The selected ')
								? error.message : 'Browser save failed; inspect Connector progress and Zotero before retrying' };
						}
						await browser.storage.local.set({ browserBridgePending: pending });
					}
				}
			}
			catch (_) {
				// Retry transport only. A claimed save is never automatically replayed.
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
};
Zotero.initDeferred.promise.then(() => Zotero.BrowserBridge.start());
