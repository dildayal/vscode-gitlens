import { MarkdownString, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri, window } from 'vscode';
import { GlyphChars } from '../../constants';
import { GitUri } from '../../git/gitUri';
import { GitLog, GitRemote, GitRemoteType, GitRevision, GitWorktree } from '../../git/models';
import { gate } from '../../system/decorators/gate';
import { debug } from '../../system/decorators/log';
import { map } from '../../system/iterable';
import { pad } from '../../system/string';
import { RepositoriesView } from '../repositoriesView';
import { WorktreesView } from '../worktreesView';
import { CommitNode } from './commitNode';
import { LoadMoreNode, MessageNode } from './common';
import { insertDateMarkers } from './helpers';
import { RepositoryNode } from './repositoryNode';
import { UncommittedFilesNode } from './UncommittedFilesNode';
import { ContextValues, ViewNode } from './viewNode';

export class WorktreeNode extends ViewNode<WorktreesView | RepositoriesView> {
	static key = ':worktree';
	static getId(repoPath: string, uri: Uri): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}(${uri.path})`;
	}

	constructor(
		uri: GitUri,
		view: WorktreesView | RepositoriesView,
		parent: ViewNode,
		public readonly worktree: GitWorktree,
	) {
		super(uri, view, parent);
	}

	override toClipboard(): string {
		return this.worktree.uri.fsPath;
	}

	override get id(): string {
		return WorktreeNode.getId(this.worktree.repoPath, this.worktree.uri);
	}

	get repoPath(): string {
		return this.uri.repoPath!;
	}

	async getChildren(): Promise<ViewNode[]> {
		const log = await this.getLog();
		if (log == null) return [new MessageNode(this.view, this, 'No commits could be found.')];

		const getBranchAndTagTips = await this.view.container.git.getBranchesAndTagsTipsFn(this.uri.repoPath);
		const children = [
			...insertDateMarkers(
				map(
					log.commits.values(),
					c => new CommitNode(this.view, this, c, undefined, undefined, getBranchAndTagTips),
				),
				this,
			),
		];

		if (log.hasMore) {
			children.push(new LoadMoreNode(this.view, this, children[children.length - 1]));
		}

		const status = await this.worktree.getStatus();
		if (status?.hasChanges) {
			children.splice(0, 0, new UncommittedFilesNode(this.view, this, status, undefined));
		}
		return children;
	}

	async getTreeItem(): Promise<TreeItem> {
		this.splatted = false;

		let description = '';
		const tooltip = new MarkdownString('', true);
		let icon: ThemeIcon | undefined;
		let hasChanges = false;
		switch (this.worktree.type) {
			case 'bare':
				icon = new ThemeIcon('folder');
				tooltip.appendMarkdown(`Bare Worktree\\\n\`${this.worktree.friendlyPath}\``);
				break;
			case 'branch': {
				const [branch, status] = await Promise.all([
					this.worktree.branch
						? this.view.container.git
								.getBranches(this.uri.repoPath, { filter: b => b.name === this.worktree.branch })
								.then(b => b.values[0])
						: undefined,
					this.worktree.getStatus(),
				]);

				tooltip.appendMarkdown(
					`Worktree for Branch $(git-branch) ${branch?.getNameWithoutRemote() ?? this.worktree.branch}${
						this.worktree.opened ? `${pad(GlyphChars.Dash, 2, 2)} _Active_ ` : ''
					}\\\n\`${this.worktree.friendlyPath}\``,
				);
				icon = new ThemeIcon('git-branch');

				if (status != null) {
					hasChanges = status.hasChanges;
					tooltip.appendMarkdown(
						`\n\n${status.getFormattedDiffStatus({
							prefix: 'Has Uncommitted Changes\\\n',
							empty: 'No Uncommitted Changes',
							expand: true,
						})}`,
					);
				}

				if (branch != null) {
					tooltip.appendMarkdown(`\n\nBranch $(git-branch) ${branch.getNameWithoutRemote()}`);

					if (!branch.remote) {
						if (branch.upstream != null) {
							let arrows = GlyphChars.Dash;

							const remote = await branch.getRemote();
							if (!branch.upstream.missing) {
								if (remote != null) {
									let left;
									let right;
									for (const { type } of remote.urls) {
										if (type === GitRemoteType.Fetch) {
											left = true;

											if (right) break;
										} else if (type === GitRemoteType.Push) {
											right = true;

											if (left) break;
										}
									}

									if (left && right) {
										arrows = GlyphChars.ArrowsRightLeft;
									} else if (right) {
										arrows = GlyphChars.ArrowRight;
									} else if (left) {
										arrows = GlyphChars.ArrowLeft;
									}
								}
							} else {
								arrows = GlyphChars.Warning;
							}

							description = `${branch.getTrackingStatus({
								empty: pad(arrows, 0, 2),
								suffix: pad(arrows, 2, 2),
							})}${branch.upstream.name}`;

							tooltip.appendMarkdown(
								` is ${branch.getTrackingStatus({
									empty: branch.upstream.missing
										? `missing upstream $(git-branch) ${branch.upstream.name}`
										: `up to date with $(git-branch)  ${branch.upstream.name}${
												remote?.provider?.name ? ` on ${remote.provider.name}` : ''
										  }`,
									expand: true,
									icons: true,
									separator: ', ',
									suffix: ` $(git-branch) ${branch.upstream.name}${
										remote?.provider?.name ? ` on ${remote.provider.name}` : ''
									}`,
								})}`,
							);
						} else {
							const providerName = GitRemote.getHighlanderProviderName(
								await this.view.container.git.getRemotesWithProviders(branch.repoPath),
							);

							tooltip.appendMarkdown(` hasn't been published to ${providerName ?? 'a remote'}`);
						}
					}
				}

				break;
			}
			case 'detached': {
				icon = new ThemeIcon('git-commit');
				tooltip.appendMarkdown(
					`Detached Worktree at $(git-commit) ${GitRevision.shorten(this.worktree.sha)}${
						this.worktree.opened ? `${pad(GlyphChars.Dash, 2, 2)} _Active_` : ''
					}\\\n\`${this.worktree.friendlyPath}\``,
				);

				const status = await this.worktree.getStatus();
				if (status != null) {
					hasChanges = status.hasChanges;
					tooltip.appendMarkdown(
						`\n\n${status.getFormattedDiffStatus({
							prefix: 'Has Uncommitted Changes',
							empty: 'No Uncommitted Changes',
							expand: true,
						})}`,
					);
				}

				break;
			}
		}

		const item = new TreeItem(this.worktree.name, TreeItemCollapsibleState.Collapsed);
		item.id = this.id;
		item.description = description;
		item.contextValue = `${ContextValues.Worktree}${this.worktree.opened ? '+active' : ''}`;
		item.iconPath = this.worktree.opened ? new ThemeIcon('check') : icon;
		item.tooltip = tooltip;
		item.resourceUri = hasChanges ? Uri.parse('gitlens-view://worktree/changes') : undefined;
		return item;
	}

	@gate()
	@debug()
	override refresh(reset?: boolean) {
		if (reset) {
			this._log = undefined;
		}
	}

	private _log: GitLog | undefined;
	private async getLog() {
		if (this._log == null) {
			this._log = await this.view.container.git.getLog(this.uri.repoPath!, {
				ref: this.worktree.sha,
				limit: this.limit ?? this.view.config.defaultItemLimit,
			});
		}

		return this._log;
	}

	get hasMore() {
		return this._log?.hasMore ?? true;
	}

	limit: number | undefined = this.view.getNodeLastKnownLimit(this);
	@gate()
	async loadMore(limit?: number | { until?: any }) {
		let log = await window.withProgress(
			{
				location: { viewId: this.view.id },
			},
			() => this.getLog(),
		);
		if (log == null || !log.hasMore) return;

		log = await log.more?.(limit ?? this.view.config.pageItemLimit);
		if (this._log === log) return;

		this._log = log;
		this.limit = log?.count;

		void this.triggerChange(false);
	}
}