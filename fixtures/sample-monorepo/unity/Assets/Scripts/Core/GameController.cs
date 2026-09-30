using Sample.Core;
using Sample.UI;

namespace Sample.Core
{
    public class GameController : MonoBehaviour
    {
        private GameState _state;
        private HudView _hud;

        public void Start()
        {
            _state = new GameState();
        }
    }
}
