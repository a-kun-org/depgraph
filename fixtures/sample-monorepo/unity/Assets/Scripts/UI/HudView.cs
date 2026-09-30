using Sample.Core;

namespace Sample.UI
{
    public class HudView
    {
        private GameState _state;

        public void Bind(GameState state)
        {
            _state = state;
        }
    }
}
