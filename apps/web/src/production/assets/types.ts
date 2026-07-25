export type AssetType = "character" | "scene" | "prop";
export interface AssetRecord { id: string; type: AssetType; role: "master" | "state"; name: string; parentAssetId: string | null; stateLabel: string | null; description: string | null; aliases: string[] }
export interface AssetGroup extends AssetRecord { states: AssetRecord[] }
export interface EpisodeRecord { id: string; index: number; title: string }
export interface CandidateRecord { id: string; assetId: string; source: { kind: "upload" | "generation"; originalName?: string; model?: string; size?: string; promptHash?: string; revisedPrompt?: string }; width: number; height: number; bytes: number; reviewRevision: number; reviewStatus: "pending" | "approved" | "rejected" }
export interface PromptParts { evidence: string; sceneIntent: string; subjectAction: string; environment: string; lightingComposition: string; styleConstraints: string }
export const ASSET_TYPE_LABEL: Record<AssetType, string> = { character: "人物", scene: "场景", prop: "道具" };
export const flattenAssets = (groups: AssetGroup[]) => groups.flatMap((group) => [group, ...group.states]);
