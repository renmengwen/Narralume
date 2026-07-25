import { AssetLibrary } from "./AssetLibrary";
import { CandidatePanel } from "./CandidatePanel";
import { ImagePromptBuilder } from "./ImagePromptBuilder";
import { useAssetWorkspace } from "./use-asset-workspace";

export function AssetStage(props: Parameters<typeof useAssetWorkspace>[0]) {
  const state = useAssetWorkspace(props);
  return <div className="grid min-h-[calc(100vh-344px)] grid-cols-[minmax(250px,.78fr)_minmax(480px,1.45fr)_minmax(330px,1fr)] max-md:grid-cols-1">
    <AssetLibrary assets={state.assets} count={state.allAssets.length} selectedId={state.selectedAsset?.id} busy={props.busy} draft={{ name: state.newAssetName, type: state.newAssetType, parentId: state.parentAssetId, stateLabel: state.stateLabel }} onDraft={(next) => { if (next.name !== undefined) state.setNewAssetName(next.name); if (next.type !== undefined) state.setNewAssetType(next.type); if (next.parentId !== undefined) state.setParentAssetId(next.parentId); if (next.stateLabel !== undefined) state.setStateLabel(next.stateLabel); }} onSelect={state.chooseAsset} onCreate={() => void state.createAsset()} />
    <ImagePromptBuilder asset={state.selectedAsset} episode={state.episode} busy={props.busy} alias={state.aliasDraft} prompt={state.prompt} parts={state.promptParts} onAlias={state.setAliasDraft} onAddAlias={() => void state.addAlias()} onPart={state.updatePromptPart} onGenerate={() => void state.generateCandidate()} />
    <CandidatePanel candidates={state.candidates} assetName={state.selectedAsset?.name} busy={props.busy} onReview={(candidate, action) => void state.reviewCandidate(candidate, action)} />
  </div>;
}
