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

	async _openOrGet(request) {
		let tab;
		if (request.url) {
			const url = new URL(request.url);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
				throw new Error('Select an HTTP(S) publication URL without credentials');
			}
			tab = await browser.tabs.create({url: request.url, active: true});
		}
		else {
			tab = await browser.tabs.get(request.tab_id);
		}
		for (let n = 0; n < 120; n++) {
			tab = await browser.tabs.get(tab.id);
			if (/^https?:/.test(tab.url) && this._tabStatus(tab).state !== 'loading') return tab;
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		return tab;
	}

	async execute(request) {
		if (request.action === 'tabs') {
			const tabs = await browser.tabs.query({});
			return { ok: true, tabs: tabs.filter(t => /^https?:/.test(t.url)).map(t => {
				const url = new URL(t.url);
				// Query strings can contain publisher access tokens.
				return { id: t.id, title: t.title, url: url.origin + url.pathname, active: t.active };
			}) };
		}
		if (request.action === 'inspect') {
			const tab = await browser.tabs.get(request.tab_id);
			if (!/^https?:/.test(tab.url)) throw new Error('Select an HTTP(S) publication tab');
			return {ok: true, tab: this._tabStatus(tab)};
		}
		if (request.action === 'open') {
			return {ok: true, tab: this._tabStatus(await this._openOrGet(request))};
		}
		if (!await Zotero.Connector.checkIsOnline()) {
			throw new Error('Open Zotero desktop before using browser CLI saving');
		}
		const selected = await Zotero.Connector.callMethod('getSelectedCollection', {});
		const target = selected.id ? `C${selected.id}` : `L${selected.libraryID}`;
		if (request.action === 'targets') {
			return { ok: true, selected: target, libraryID: selected.libraryID,
				libraryName: selected.libraryName, targets: selected.targets };
		}
		if (request.action !== 'save') throw new Error('Unknown browser action');
		if (request.target && request.target !== target) {
			throw new Error(`Select ${request.target} in Zotero first (currently ${target}); no save was started`);
		}
		if (!selected.libraryEditable || selected.filesEditable === false) {
			throw new Error('The selected Zotero target does not allow saving files');
		}
		if (Zotero.Prefs.get('firstUse')) {
			throw new Error('Complete the Connector first-use prompt with its toolbar button first');
		}
		const tab = await this._openOrGet(request);
		if (!/^https?:/.test(tab.url)) throw new Error('Select an HTTP(S) publication tab');
		const page = this._tabStatus(tab);
		if (page.state !== 'ready') {
			return {ok: false, tab: page, state: page.state,
				error: 'Connector page needs attention or is still loading; resolve it in the browser, then save the same tab ID'};
		}
		const info = Zotero.Connector_Browser.getTabInfo(tab.id);
		if (request.require_pdf !== false && !info.translators?.length && !info.isPDF) {
			return {ok: false, tab: page, state: 'needs_user_action',
				error: 'Connector found no publication translator or PDF; inspect login/access in this tab before saving'};
		}
		if (!info.detectionDone && !info.isPDF && !info.uninjectable) {
			throw new Error('Connector detection is not ready; reload the publication tab and retry');
		}
		const saved = await Zotero.Connector_Browser.onZoteroButtonElementClick(tab, { cliSave: true });
		if (!saved || !saved.sessionID || !saved.desktopSaved) {
			throw new Error('Connector returned no save receipt. The outcome is unknown; inspect Zotero before retrying');
		}
		const after = await Zotero.Connector.callMethod('getSelectedCollection', {});
		const afterTarget = after.id ? `C${after.id}` : `L${after.libraryID}`;
		const result = { ...saved, tab: page, selectedTarget: afterTarget, libraryID: after.libraryID, libraryName: after.libraryName };
		if (afterTarget !== target || saved.target !== target) {
			return { ...result, ok: false, error: 'Zotero target changed during saving; inspect the saved items before retrying' };
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
