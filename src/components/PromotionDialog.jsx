import { pieceIcon } from '../core/pieces';

const TYPES = ['q', 'r', 'b', 'n'];

export function PromotionDialog({ visible, color, onChoose }) {
  return (
    <div className={'promotion-overlay' + (visible ? ' show' : '')} id="promotionOverlay">
      <div className="promotion-dialog">
        <h3>Promote to:</h3>
        <div id="promotionChoices">
          {visible &&
            TYPES.map((t) => (
              <div key={t} className="promotion-piece" onClick={() => onChoose(t)}>
                <img src={pieceIcon(color, t)} alt={'Promote to ' + t.toUpperCase()} />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
