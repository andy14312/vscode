/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from 'vs/base/common/lifecycle';
import { renderMarkdown } from 'vs/base/browser/markdownRenderer';
import { Event, Emitter } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IHoverTarget, IHoverOptions } from 'vs/workbench/contrib/hover/browser/hover';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { EDITOR_FONT_DEFAULTS, IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { HoverWidget as BaseHoverWidget, renderHoverAction } from 'vs/base/browser/ui/hover/hoverWidget';
import { Widget } from 'vs/base/browser/ui/widget';
import { AnchorPosition } from 'vs/base/browser/ui/contextview/contextview';
import { IOpenerService } from 'vs/platform/opener/common/opener';

const $ = dom.$;

export class HoverWidget extends Widget {
	private readonly _messageListeners = new DisposableStore();
	private readonly _mouseTracker: CompositeMouseTracker;

	private readonly _hover: BaseHoverWidget;
	private readonly _target: IHoverTarget;
	private readonly _linkHandler: (url: string) => any;

	private _isDisposed: boolean = false;
	private _anchor: AnchorPosition = AnchorPosition.ABOVE;
	private _x: number = 0;
	private _y: number = 0;

	get isDisposed(): boolean { return this._isDisposed; }
	get domNode(): HTMLElement { return this._hover.containerDomNode; }

	private readonly _onDispose = this._register(new Emitter<void>());
	get onDispose(): Event<void> { return this._onDispose.event; }
	private readonly _onRequestLayout = this._register(new Emitter<void>());
	get onRequestLayout(): Event<void> { return this._onRequestLayout.event; }

	get anchor(): AnchorPosition { return this._anchor; }
	get x(): number { return this._x; }
	get y(): number { return this._y; }

	constructor(
		options: IHoverOptions,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOpenerService private readonly _openerService: IOpenerService
	) {
		super();

		this._linkHandler = options.linkHandler || this._openerService.open;

		this._target = 'targetElements' in options.target ? options.target : new ElementHoverTarget(options.target);

		this._hover = this._register(new BaseHoverWidget());

		this._hover.containerDomNode.classList.add('workbench-hover', 'fadeIn');
		if (options.additionalClasses) {
			this._hover.containerDomNode.classList.add(...options.additionalClasses);
		}

		// Don't allow mousedown out of the widget, otherwise preventDefault will call and text will
		// not be selected.
		this.onmousedown(this._hover.containerDomNode, e => e.stopPropagation());

		// Hide hover on escape
		this.onkeydown(this._hover.containerDomNode, e => {
			if (e.equals(KeyCode.Escape)) {
				this.dispose();
			}
		});

		const rowElement = $('div.hover-row.markdown-hover');
		const contentsElement = $('div.hover-contents');
		const markdownElement = renderMarkdown(options.text, {
			actionHandler: {
				callback: (content) => this._linkHandler(content),
				disposeables: this._messageListeners
			},
			codeBlockRenderer: async (_, value) => {
				const fontFamily = this._configurationService.getValue<IEditorOptions>('editor').fontFamily || EDITOR_FONT_DEFAULTS.fontFamily;
				return `<span style="font-family: ${fontFamily}; white-space: nowrap">${value.replace(/\n/g, '<br>')}</span>`;
			},
			codeBlockRenderCallback: () => {
				contentsElement.classList.add('code-hover-contents');
				// This changes the dimensions of the hover so trigger a layout
				this._onRequestLayout.fire();
			}
		});
		contentsElement.appendChild(markdownElement);
		rowElement.appendChild(contentsElement);
		this._hover.contentsDomNode.appendChild(rowElement);

		if (options.actions && options.actions.length > 0) {
			const statusBarElement = $('div.hover-row.status-bar');
			const actionsElement = $('div.actions');
			options.actions.forEach(action => {
				const keybinding = this._keybindingService.lookupKeybinding(action.commandId);
				const keybindingLabel = keybinding ? keybinding.getLabel() : null;
				renderHoverAction(actionsElement, {
					label: action.label,
					commandId: action.commandId,
					run: e => {
						action.run(e);
						this.dispose();
					},
					iconClass: action.iconClass
				}, keybindingLabel);
			});
			statusBarElement.appendChild(actionsElement);
			this._hover.containerDomNode.appendChild(statusBarElement);
		}

		this._mouseTracker = new CompositeMouseTracker([this._hover.containerDomNode, ...this._target.targetElements]);
		this._register(this._mouseTracker.onMouseOut(() => this.dispose()));
		this._register(this._mouseTracker);
	}

	public render(container?: HTMLElement): void {
		if (this._hover.containerDomNode.parentElement !== container) {
			container?.appendChild(this._hover.containerDomNode);
		}

		this.layout();
	}

	public layout() {
		this._hover.containerDomNode.classList.remove('right-aligned');
		this._hover.contentsDomNode.style.maxHeight = '';

		// Get horizontal alignment and position
		const targetBounds = this._target.targetElements.map(e => e.getBoundingClientRect());
		const targetLeft = Math.min(...targetBounds.map(e => e.left));
		if (targetLeft + this._hover.containerDomNode.clientWidth >= document.documentElement.clientWidth) {
			// TODO: Communicate horizontal alignment to contextviewservice?
			this._x = document.documentElement.clientWidth;
			this._hover.containerDomNode.classList.add('right-aligned');
		} else {
			this._x = targetLeft;
		}

		// Get vertical alignment and position
		const targetTop = Math.min(...targetBounds.map(e => e.top));
		if (targetTop - this._hover.containerDomNode.clientHeight < 0) {
			// TODO: Cap max height
			this._anchor = AnchorPosition.BELOW;
			this._y = Math.max(...targetBounds.map(e => e.bottom)) - 2;
		} else {
			this._y = targetTop;
		}

		this._hover.onContentsChanged();
	}

	public focus() {
		this._hover.containerDomNode.focus();
	}

	public hide(): void {
		this.dispose();
	}

	public dispose(): void {
		if (!this._isDisposed) {
			this._onDispose.fire();
			this._hover.containerDomNode.parentElement?.removeChild(this.domNode);
			this._messageListeners.dispose();
			this._target.dispose();
			super.dispose();
		}
		this._isDisposed = true;
	}
}

class CompositeMouseTracker extends Widget {
	private _isMouseIn: boolean = false;
	private _mouseTimeout: number | undefined;

	private readonly _onMouseOut = new Emitter<void>();
	get onMouseOut(): Event<void> { return this._onMouseOut.event; }

	constructor(
		private _elements: HTMLElement[]
	) {
		super();
		this._elements.forEach(n => this.onmouseover(n, () => this._onTargetMouseOver()));
		this._elements.forEach(n => this.onnonbubblingmouseout(n, () => this._onTargetMouseOut()));
	}

	private _onTargetMouseOver(): void {
		this._isMouseIn = true;
		this._clearEvaluateMouseStateTimeout();
	}

	private _onTargetMouseOut(): void {
		this._isMouseIn = false;
		this._evaluateMouseState();
	}

	private _evaluateMouseState(): void {
		this._clearEvaluateMouseStateTimeout();
		// Evaluate whether the mouse is still outside asynchronously such that other mouse targets
		// have the opportunity to first their mouse in event.
		this._mouseTimeout = window.setTimeout(() => this._fireIfMouseOutside(), 0);
	}

	private _clearEvaluateMouseStateTimeout(): void {
		if (this._mouseTimeout) {
			clearTimeout(this._mouseTimeout);
			this._mouseTimeout = undefined;
		}
	}

	private _fireIfMouseOutside(): void {
		if (!this._isMouseIn) {
			this._onMouseOut.fire();
		}
	}
}

class ElementHoverTarget implements IHoverTarget {
	readonly targetElements: readonly HTMLElement[];

	constructor(
		private _element: HTMLElement
	) {
		this.targetElements = [this._element];
	}

	dispose(): void {
	}
}
