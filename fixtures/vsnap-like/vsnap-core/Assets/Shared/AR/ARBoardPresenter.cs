namespace Vsnap.AR
{
    public class ARBoardPresenter
    {
        private SessionRunner _runner;
        private CardView _card;

        public void Present(SessionRunner runner, CardView card)
        {
            _runner = runner;
            _card = card;
        }
    }
}
